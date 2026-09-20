/**
 * 大型法会临时僧众管理 —— 关键流程测试（node:test + Fastify inject）
 *
 * 每个用例在独立法会/独立房间内运行，避免相互干扰；
 * 数据落库（真实事务、排他约束、触发器），结束后清理本用例数据。
 *
 * 运行：npm test（需 PostgreSQL 已启动并完成 03_ceremony.sql 迁移）
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../src/db.js';
import { buildApp } from '../src/app.js';

const app = buildApp();

async function http(method: string, url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload, headers: { 'content-type': 'application/json' } });
  return { status: res.statusCode, body: res.json() };
}

// 每个用例独占房间，避免不同法会区间在同一批床位上互相干扰
async function makeRooms(prefix: string, count: number, capacity = 4): Promise<string> {
  const tag = randomUUID().slice(0, 8);
  let first = '';
  for (let i = 1; i <= count; i++) {
    const r = await http('POST', '/api/rooms', {
      room_no: `测房-${prefix}-${tag}-${i}`, capacity, note: '测试法会房',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    if (!first) first = r.body.id as string;
  }
  return first;
}

async function createCeremony(nameSuffix: string, cap = 5,
  dates: { start: string; end: string } = { start: '2027-05-01', end: '2027-05-07' }) {
  const r = await http('POST', '/api/ceremonies', {
    name: `测试法会-${nameSuffix}`,
    start_date: dates.start,
    end_date: dates.end,
    daily_capacity: cap,
  });
  assert.equal(r.status, 201);
  return r.body.id as string;
}

interface ImportResult {
  result: string;
  code?: string;
  message: string;
  participant_id?: string;
}

async function importRows(cid: string, rows: Record<string, unknown>[]) {
  const r = await http('POST', `/api/ceremonies/${cid}/import`, { rows });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as {
    total: number; imported: number; waitlisted: number; errors: number;
    results: ImportResult[];
  };
}

const person = (i: number, patch: Record<string, unknown> = {}) => ({
  法名: `测僧${i}`,
  戒牒编号: `TEST-${randomUUID().slice(0, 8)}-${i}`,
  到寺日期: '2027-05-01',
  离寺日期: '2027-05-06',
  ...patch,
});

// 用例结束即清理本用例数据（房间先删分配再删），避免床位区间跨用例干扰
async function cleanupCeremony(cid: string, roomPrefix?: string) {
  if (roomPrefix) {
    await pool.query(
      `DELETE FROM ceremony_bed_assignments WHERE bed_id IN
         (SELECT b.id FROM beds b JOIN rooms r ON r.id=b.room_id WHERE r.room_no LIKE $1)`,
      [`测房-${roomPrefix}-%`],
    );
    await pool.query(
      `DELETE FROM beds WHERE room_id IN (SELECT id FROM rooms WHERE room_no LIKE $1)`,
      [`测房-${roomPrefix}-%`],
    );
  }
  await pool.query('DELETE FROM ceremonies WHERE id=$1', [cid]);
  if (roomPrefix) await pool.query('DELETE FROM rooms WHERE room_no LIKE $1', [`测房-${roomPrefix}-%`]);
  await pool.query(`DELETE FROM monks WHERE ordination_no LIKE 'TEST-%' AND id NOT IN
    (SELECT monk_id FROM ceremony_participants WHERE monk_id IS NOT NULL)`);
}

after(async () => {
  // 级联删除用例法会（人员/分配/日志），再删用例房间与临时僧人档
  await pool.query(`DELETE FROM ceremonies WHERE name LIKE '测试法会-%'`);
  await pool.query(`DELETE FROM monks WHERE ordination_no LIKE 'TEST-%'`);
  await pool.query(`DELETE FROM rooms WHERE room_no LIKE '测房-%'`);
  await app.close();
  await pool.end();
});

test('导入逐行反馈：成功 / 重复 / 日期非法 / 超容量候补', async () => {
  const cid = await createCeremony('导入', 3);
  const dup = person(1);
  const rows = [
    dup,
    person(2),
    person(3),
    person(4), // 第 4 人 -> 候补
    { ...dup, 法名: '重复同戒牒' }, // 同批次戒牒重复
    { 法名: '无日期僧', 戒牒编号: randomUUID() },
    { 法名: '坏日期', 戒牒编号: randomUUID(), 到寺日期: '2027/05/01', 离寺日期: '2027-05-06' },
    { 法名: '倒序', 戒牒编号: randomUUID(), 到寺日期: '2027-05-06', 离寺日期: '2027-05-01' },
    { 法名: '超会期', 戒牒编号: randomUUID(), 到寺日期: '2027-06-01', 离寺日期: '2027-06-03' },
  ];
  const imp = await importRows(cid, rows);
  assert.equal(imp.total, 9);
  assert.equal(imp.imported, 3);
  assert.equal(imp.waitlisted, 1);
  assert.equal(imp.errors, 5);
  const codes = imp.results.map((r) => r.code ?? r.result);
  assert.deepEqual(codes, ['ok', 'ok', 'ok', 'waitlisted', 'duplicate',
    'invalid', 'invalid', 'invalid', 'invalid']);
  assert.match(imp.results[3].message, /接待已满/);
  await cleanupCeremony(cid);
});

test('同法会二次导入同戒牒 -> duplicate，且不产生新人档', async () => {
  const cid = await createCeremony('重复导入', 5);
  const row = person(1);
  await importRows(cid, [row]);
  const again = await importRows(cid, [{ ...row, 法名: '另一个法名' }]);
  assert.equal(again.results[0].code, 'duplicate');
  assert.equal(again.imported, 0);
  await cleanupCeremony(cid);
});

test('分组自动分床：同到离寺+同特殊需求聚住；调床冲突 409', async () => {
  await makeRooms('分床', 2, 4);
  const cid = await createCeremony('分床', 6);
  const imp = await importRows(cid, [
    person(1, { 特殊需求: '病僧需陪护' }),
    person(2, { 特殊需求: '病僧需陪护' }),
    person(3),
    person(4),
    person(5),
    person(6),
  ]);
  assert.equal(imp.imported, 6);
  const r = await http('POST', `/api/ceremonies/${cid}/auto-assign`, {});
  assert.equal(r.status, 200);
  // 两间房共 8 张全程空闲床，6 人应全部分到
  assert.equal(r.body.assigned, 6);

  const list = await http('GET', `/api/ceremonies/${cid}/participants`);
  const beds = list.body.map((p: { dharma_name: string; room_no: string }) => `${p.dharma_name}:${p.room_no}`);
  const sick = beds.filter((b: string) => b.startsWith('测僧1') || b.startsWith('测僧2'));
  // 两位病僧同房间
  assert.equal(new Set(sick.map((b) => b.split(':')[1])).size, 1);

  // 调床冲突：把 测僧3 调到 测僧4 已占用的床 -> 409（床 id 由 DB 直取）
  const p3 = list.body.find((p: { dharma_name: string }) => p.dharma_name === '测僧3');
  const p4 = list.body.find((p: { dharma_name: string }) => p.dharma_name === '测僧4');
  const p4Bed = (await pool.query(
    `SELECT bed_id FROM ceremony_bed_assignments WHERE participant_id=$1 AND status='active'`,
    [p4.id],
  )).rows[0].bed_id as string;
  const conflict = await http('PUT', `/api/ceremonies/${cid}/participants/${p3.id}/bed`, { bed_id: p4Bed });
  assert.equal(conflict.status, 409);
  await cleanupCeremony(cid, '分床');
});

test('候补 → 释放自动递补(proposed) → 知客确认(registered)，区间截断并留痕', async () => {
  await makeRooms('候补', 1, 4);
  const cid = await createCeremony('候补', 3);
  const imp = await importRows(cid, [person(1), person(2), person(3), person(4)]);
  assert.equal(imp.imported, 3);
  assert.equal(imp.waitlisted, 1);
  await http('POST', `/api/ceremonies/${cid}/auto-assign`, {});
  await http('POST', `/api/ceremonies/${cid}/start`, {});

  const p4id = imp.results.find((r) => r.result === 'waitlisted')!.participant_id!;
  // 第 1 人提前离寺（05-03），释放名额+床位
  const p1id = imp.results[0].participant_id!;
  const leave = await http('POST', `/api/ceremonies/${cid}/participants/${p1id}/early-leave`,
    { leave_date: '2027-05-03' });
  assert.equal(leave.status, 200);
  assert.equal(leave.body.promoted.id, p4id);

  const list = await http('GET', `/api/ceremonies/${cid}/participants`);
  const p4 = list.body.find((p: { id: string }) => p.id === p4id);
  assert.equal(p4.status, 'proposed');
  assert.equal(p4.arrive_date, '2027-05-03'); // 区间已截断
  assert.ok(p4.room_no, '递补时已占床');

  // 知客确认
  const ok = await http('POST', `/api/ceremonies/${cid}/participants/${p4id}/confirm`, {});
  assert.equal(ok.status, 200);
  const list2 = await http('GET', `/api/ceremonies/${cid}/participants`);
  assert.equal(list2.body.find((p: { id: string }) => p.id === p4id).status, 'registered');

  // 流水完整：含 import / auto_assign / promote / promote_confirm / early_leave
  const logs = await http('GET', `/api/ceremonies/${cid}/logs`);
  const actions = new Set(logs.body.map((l: { action: string }) => l.action));
  for (const a of ['import', 'auto_assign', 'promote', 'promote_confirm', 'early_leave']) {
    assert.ok(actions.has(a), `缺少流水 ${a}`);
  }
  await cleanupCeremony(cid, '候补');
});

test('拒绝递补：回候补并继续尝试下一位', async () => {
  await makeRooms('拒补', 1, 4);
  const cid = await createCeremony('拒补', 2);
  const imp = await importRows(cid, [person(1), person(2), person(3), person(4)]);
  await http('POST', `/api/ceremonies/${cid}/auto-assign`, {});
  await http('POST', `/api/ceremonies/${cid}/start`, {});
  const [w1, w2] = imp.results.filter((r) => r.result === 'waitlisted').map((r) => r.participant_id!);
  assert.ok(w1 && w2, '应有两名候补');
  const p1id = imp.results[0].participant_id!;
  await http('POST', `/api/ceremonies/${cid}/participants/${p1id}/early-leave`, { leave_date: '2027-05-02' });

  const reject = await http('POST', `/api/ceremonies/${cid}/participants/${w1}/reject`, { reason: '联系不上' });
  assert.equal(reject.status, 200);
  const list = await http('GET', `/api/ceremonies/${cid}/participants`);
  assert.equal(list.body.find((p: { id: string }) => p.id === w1).status, 'waitlisted');
  // 下一位获得 proposed
  assert.equal(list.body.find((p: { id: string }) => p.id === w2).status, 'proposed');
  await cleanupCeremony(cid, '拒补');
});

test('签到：批量签到/迟到/未到；未到释放床位并递补', async () => {
  await makeRooms('签到', 1, 4);
  const cid = await createCeremony('签到', 3);
  const imp = await importRows(cid, [person(1), person(2), person(3), person(4)]);
  await http('POST', `/api/ceremonies/${cid}/auto-assign`, {});
  await http('POST', `/api/ceremonies/${cid}/start`, {});
  // a 正常签到；b 留待标记未到；c 迟到；d 候补
  const [a, b, c, d] = imp.results.map((r) => r.participant_id!);

  const ck = await http('POST', `/api/ceremonies/${cid}/checkins/bulk`,
    { participant_ids: [a], action: 'checkin' });
  assert.equal(ck.body.processed, 1);
  // 显式迟到（第 3 名已登记人员）
  const late = await http('POST', `/api/ceremonies/${cid}/participants/${c}/checkin/late`, {});
  assert.equal(late.status, 200);
  // 候补人员不能签到
  const lateWait = await http('POST', `/api/ceremonies/${cid}/participants/${d}/checkin/late`, {});
  assert.equal(lateWait.status, 409);
  // 已签到者不能再标未到（批量跳过，processed=0）
  const nsAgain = await http('POST', `/api/ceremonies/${cid}/checkins/bulk`,
    { participant_ids: [a], action: 'no_show' });
  assert.equal(nsAgain.body.processed, 0);

  const list = await http('GET', `/api/ceremonies/${cid}/participants`);
  assert.equal(list.body.find((p: { id: string }) => p.id === a).status, 'checked_in');
  assert.equal(list.body.find((p: { id: string }) => p.id === c).status, 'late');

  // b 始终未签到 -> 未到：释放床位、触发候补递补
  const ns = await http('POST', `/api/ceremonies/${cid}/checkins/bulk`,
    { participant_ids: [b], action: 'no_show' });
  assert.equal(ns.status, 200);
  const list2 = await http('GET', `/api/ceremonies/${cid}/participants`);
  assert.equal(list2.body.find((p: { id: string }) => p.id === b).status, 'no_show');
  assert.equal(list2.body.find((p: { id: string }) => p.id === d).status, 'proposed');
  await cleanupCeremony(cid, '签到');
});

test('圆满：批量释放床位并冻结实到率/床位峰值/每日趋势', async () => {
  await makeRooms('圆满', 1, 4);
  const cid = await createCeremony('圆满', 4);
  const imp = await importRows(cid, [person(1), person(2), person(3), person(4), person(5)]);
  await http('POST', `/api/ceremonies/${cid}/auto-assign`, {});
  await http('POST', `/api/ceremonies/${cid}/start`, {});
  const ids = imp.results.map((r) => r.participant_id!);
  await http('POST', `/api/ceremonies/${cid}/checkins/bulk`,
    { participant_ids: ids.slice(0, 3), action: 'checkin' });

  const close = await http('POST', `/api/ceremonies/${cid}/close`, {});
  assert.equal(close.status, 200);
  const stats = close.body.stats;
  assert.equal(stats.arrived, 3);
  assert.equal(stats.admitted, 4);
  assert.equal(stats.arrival_rate, 75);
  assert.ok(stats.bed_peak >= 3);
  assert.ok(Array.isArray(stats.daily) && stats.daily.length === 7);

  // final_stats 已冻结
  const c = await http('GET', `/api/ceremonies/${cid}`);
  assert.equal(c.body.status, 'closed');
  assert.ok(c.body.final_stats);
  // 所有 active 床位已批量释放
  const list = await http('GET', `/api/ceremonies/${cid}/participants`);
  assert.ok(list.body.every((p: { bed_no: string | null }) => !p.bed_no));

  // 圆满后禁止再操作
  const again = await http('POST', `/api/ceremonies/${cid}/checkins/bulk`,
    { participant_ids: [ids[0]], action: 'checkin' });
  assert.equal(again.status, 409);
  await cleanupCeremony(cid, '圆满');
});

test('法会临时人员不进入考勤（登记被拒，不触发缺勤告警）', async () => {
  const cid = await createCeremony('隔离', 2);
  const imp = await importRows(cid, [person(1)]);
  const pid = imp.results[0].participant_id!;
  const monkId = (await pool.query(
    'SELECT monk_id FROM ceremony_participants WHERE id=$1', [pid],
  )).rows[0].monk_id;

  const r = await http('POST', '/api/attendance', {
    monk_id: monkId, attend_date: '2027-05-02', session: 'morning', status: 'absent',
  });
  assert.equal(r.status, 400);

  // 常规考勤总览不含 ceremony 状态僧人
  const roster = await http('GET', '/api/attendance?attend_date=2027-05-02&session=morning');
  assert.ok(roster.body.every((m: { monk_id: string }) => m.monk_id !== monkId));
  await cleanupCeremony(cid);
});

test('跨法会日期撞期与现有挂单重叠检测', async () => {
  const c1 = await createCeremony('撞期甲', 3);
  const row = person(1); // 05-01 ~ 05-06 在寺
  const imp1 = await importRows(c1, [row]);
  assert.equal(imp1.results[0].result, 'ok');
  const monkId = (await pool.query(
    'SELECT monk_id FROM ceremony_participants WHERE id=$1', [imp1.results[0].participant_id],
  )).rows[0].monk_id;

  // 乙法会会期与甲重叠；该僧在乙会期内的住宿仍与甲在寺区间撞期 -> conflict
  const c2 = await createCeremony('撞期乙', 3, { start: '2027-05-04', end: '2027-05-20' });
  const imp2 = await importRows(c2, [{
    法名: row.法名, 戒牒编号: row.戒牒编号,
    到寺日期: '2027-05-04', 离寺日期: '2027-05-08', // 与甲（住至 05-06）重叠
  }]);
  assert.equal(imp2.results[0].code, 'conflict');

  // 甲离寺（05-06 为最后在寺日）之后再到乙 -> ok
  const imp3 = await importRows(c2, [{
    法名: row.法名, 戒牒编号: row.戒牒编号,
    到寺日期: '2027-05-07', 离寺日期: '2027-05-10',
  }]);
  assert.equal(imp3.results[0].result, 'ok');
  assert.ok(monkId);
  await cleanupCeremony(c1);
  await cleanupCeremony(c2);
});

test('并发抢占同床：排他约束保证仅一方成功', async () => {
  const { Pool } = await import('pg');
  const pgPool = new Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'sangha',
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    max: 4,
  });
  const roomId = await makeRooms('并发', 1, 4);
  const cid = await createCeremony('并发', 5);
  const imp = await importRows(cid, [person(1), person(2)]);
  const [pA, pB] = imp.results.map((r) => r.participant_id!);
  const bed = (await pgPool.query(
    `INSERT INTO beds (room_id,bed_no) VALUES ($1,'并发试床') RETURNING id`, [roomId],
  )).rows[0].id as string;

  const c1 = await pgPool.connect();
  const c2 = await pgPool.connect();
  await c1.query('BEGIN');
  await c2.query('BEGIN');
  // 排他约束冲突可能等待行锁；加锁超时避免双事务无限等待
  await c1.query('SET LOCAL lock_timeout = 3000');
  await c2.query('SET LOCAL lock_timeout = 3000');
  const sql = `INSERT INTO ceremony_bed_assignments
      (ceremony_id,participant_id,bed_id,stay_range,status)
    VALUES ($1,$2,$3,daterange('2027-05-01','2027-05-03'),'active')`;
  let failures = 0;
  const [r1, r2] = await Promise.allSettled([
    c1.query(sql, [cid, pA, bed]),
    c2.query(sql, [cid, pB, bed]),
  ]);
  if (r1.status === 'fulfilled') await c1.query('COMMIT');
  else { failures++; await c1.query('ROLLBACK').catch(() => {}); }
  if (r2.status === 'fulfilled') await c2.query('COMMIT');
  else { failures++; await c2.query('ROLLBACK').catch(() => {}); }
  c1.release();
  c2.release();
  assert.ok(failures >= 1, '并发抢占同床必须有一方被拒绝/等待超时');

  const active = await pgPool.query(
    `SELECT count(*)::int n FROM ceremony_bed_assignments
      WHERE bed_id=$1 AND status='active'`, [bed],
  );
  assert.equal(active.rows[0].n, 1, '同床重叠区间只能存在一条 active 占用');
  await pgPool.query('DELETE FROM ceremony_bed_assignments WHERE bed_id=$1', [bed]);
  await pgPool.query('DELETE FROM beds WHERE id=$1', [bed]);
  await pgPool.end();
  await cleanupCeremony(cid, '并发');
});

