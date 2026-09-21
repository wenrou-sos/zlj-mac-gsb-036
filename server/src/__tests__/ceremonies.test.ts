import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../app.js';
import { pool } from '../db.js';

// 测试用未来日期（容量约束自当天起校验），避免与种子法会/挂单期间重叠
const FUTURE = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().slice(0, 10);
})();
const FUT_END = (() => {
  const d = new Date(FUTURE);
  d.setDate(d.getDate() + 4);
  return d.toISOString().slice(0, 10);
})();
const MID = (() => {
  const d = new Date(FUTURE);
  d.setDate(d.getDate() + 2);
  return d.toISOString().slice(0, 10);
})();

interface ParticipantLike {
  id: string;
  dharma_name: string;
  status: string;
  bed_no: string | null;
  room_no: string | null;
  stay_status: string | null;
  arrive_date: string;
  leave_date: string;
}

const app = await buildApp();
let testRoomId = '';
const bedIds: string[] = [];
let conflictMonkId = '';

async function cleanupCeremony(cid: string) {
  await pool.query('DELETE FROM dharma_ceremonies WHERE id=$1', [cid]);
}

async function makeCeremony(capacity: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/ceremonies',
    payload: { name: `测试法会 ${randomUUID()}`, start_date: FUTURE, end_date: FUT_END, capacity },
  });
  assert.equal(res.statusCode, 201, res.body);
  return (res.json() as { id: string }).id;
}

async function importRows(cid: string, rows: Record<string, unknown>[]) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/ceremonies/${cid}/import`,
    payload: { rows },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as {
    accepted_count: number; waitlisted_count: number; duplicate_count: number;
    conflict_count: number; invalid_count: number;
    row_results: { row_no: number; status: string; message: string; participant_id?: string | null }[];
  };
}

const row = (name: string, no: string, arrive = FUTURE, leave = FUT_END) => ({
  dharma_name: name, ordination_no: no, arrive_date: arrive, leave_date: leave,
});

async function getParticipants(cid: string, status?: string): Promise<ParticipantLike[]> {
  const url = `/api/ceremonies/${cid}/participants${status ? `?status=${status}` : ''}`;
  const res = await app.inject({ method: 'GET', url });
  assert.equal(res.statusCode, 200);
  return res.json() as ParticipantLike[];
}

before(async () => {
  const room = await pool.query(
    `INSERT INTO rooms (room_no, capacity, note) VALUES ($1, 3, '法会测试房') RETURNING id`,
    [`测试房 ${randomUUID().slice(0, 8)}`],
  );
  testRoomId = room.rows[0].id;
  const beds = await pool.query(
    `INSERT INTO beds (room_id, bed_no) VALUES ($1,'1'),($1,'2'),($1,'3') RETURNING id`,
    [testRoomId],
  );
  bedIds.push(...beds.rows.map((b: { id: string }) => b.id));

  // 一位在 FUTURE 期间“在寺挂单”的僧人，用于撞期校验
  const monk = await pool.query(
    `INSERT INTO monks (dharma_name, home_monastery, ordination_no, status)
     VALUES ('撞期师', '测试撞期寺', 'CONFLICT-ORD-1', 'guadan') RETURNING id`,
  );
  conflictMonkId = monk.rows[0].id;
  await pool.query(
    `INSERT INTO guadan (monk_id, arrive_date, expected_days, status)
     VALUES ($1, $2, 30, 'active')`,
    [conflictMonkId, FUTURE],
  );
});

after(async () => {
  await pool.query('DELETE FROM guadan WHERE monk_id=$1', [conflictMonkId]);
  await pool.query('DELETE FROM monks WHERE id=$1', [conflictMonkId]);
  await pool.query('DELETE FROM rooms WHERE id=$1', [testRoomId]);
  await app.close();
  await pool.end();
});

describe('法会创建与导入逐行反馈', () => {
  let cid = '';

  test('创建法会：结束早于开始被拒', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ceremonies',
      payload: { name: '非法日期', start_date: FUT_END, end_date: FUTURE, capacity: 2 },
    });
    assert.equal(res.statusCode, 400);
  });

  test('创建法会成功', async () => {
    cid = await makeCeremony(2);
  });

  test('导入：合法 / 空法名 / 批内重复 / 与现有挂单撞期 / 日期越界', async () => {
    const r = await importRows(cid, [
      row('正常甲', `T-${randomUUID().slice(0, 8)}`),
      { dharma_name: '', ordination_no: 'X', arrive_date: FUTURE, leave_date: FUT_END },
      row('正常甲二', 'DUP-1'),
      row('重复乙', 'DUP-1'),
      row('撞期师', 'CONFLICT-ORD-1'),
      { dharma_name: '越界丙', ordination_no: 'OUT-1', arrive_date: '2020-01-01', leave_date: '2020-01-02' },
    ]);
    assert.deepEqual(r.row_results.map((x) => x.status),
      ['accepted', 'invalid', 'accepted', 'duplicate', 'conflict', 'invalid']);
    assert.equal(r.accepted_count, 2);
    assert.equal(r.invalid_count, 2);
    assert.equal(r.duplicate_count, 1);
    assert.equal(r.conflict_count, 1);
    assert.match(r.row_results[4].message, /撞期/);
  });

  test('容量已满：后续导入逐行进入候补', async () => {
    const r = await importRows(cid, [
      row('满员丙', `T-${randomUUID().slice(0, 8)}`),
      row('候补丁', `T-${randomUUID().slice(0, 8)}`),
    ]);
    assert.deepEqual(r.row_results.map((x) => x.status), ['waitlisted', 'waitlisted']);
    assert.equal(r.waitlisted_count, 2);
  });

  test('重复导入已登记戒牒 → duplicate，不影响同行其他人', async () => {
    const r = await importRows(cid, [row('再来一次', 'DUP-1'), row('新人戊', `T-${randomUUID().slice(0, 8)}`)]);
    assert.equal(r.row_results[0].status, 'duplicate');
    assert.equal(r.row_results[1].status, 'waitlisted');
  });

  test('导入批次与逐行结果完整保留', async () => {
    const list = await app.inject({ method: 'GET', url: `/api/ceremonies/${cid}/import-batches` });
    const batches = list.json() as { id: string }[];
    assert.ok(batches.length >= 3);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/ceremonies/${cid}/import-batches/${batches[0].id}`,
    });
    assert.equal(detail.statusCode, 200);
    assert.ok(Array.isArray((detail.json() as { row_results: unknown[] }).row_results));
  });

  after(async () => cleanupCeremony(cid));
});

describe('床位分配、日期重叠与并发抢占', () => {
  let cid = '';

  test('准备法会并自动分床 3 人', async () => {
    cid = await makeCeremony(10);
    await importRows(cid, [
      row('分床甲', `T-${randomUUID().slice(0, 8)}`),
      row('分床乙', `T-${randomUUID().slice(0, 8)}`),
      row('分床丙', `T-${randomUUID().slice(0, 8)}`),
    ]);
    const res = await app.inject({ method: 'POST', url: `/api/ceremonies/${cid}/allocate-beds`, payload: {} });
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { allocated: unknown[] }).allocated.length, 3);
  });

  test('手工分床到现有常住入住床位 → 409', async () => {
    const occ = await pool.query<{ id: string }>(`SELECT id FROM beds WHERE monk_id IS NOT NULL LIMIT 1`);
    const ppl = await getParticipants(cid, 'confirmed');
    const res = await app.inject({
      method: 'PUT',
      url: `/api/ceremonies/${cid}/participants/${ppl[0].id}/bed`,
      payload: { bed_id: occ.rows[0].id, stay_start: FUTURE, stay_end: FUT_END },
    });
    assert.equal(res.statusCode, 409);
  });

  test('调床到他人日期重叠床位 → 409', async () => {
    const list = await getParticipants(cid, 'confirmed');
    const [a, b] = list;
    assert.ok(a.bed_no && b.bed_no && a.bed_no !== b.bed_no);
    const aBed = await pool.query<{ id: string }>(
      `SELECT b.id FROM beds b JOIN rooms r ON r.id=b.room_id
       WHERE r.room_no=$1 AND b.bed_no=$2`,
      [a.room_no, a.bed_no],
    );
    const res = await app.inject({
      method: 'PUT',
      url: `/api/ceremonies/${cid}/participants/${b.id}/bed`,
      payload: { bed_id: aBed.rows[0].id, stay_start: FUTURE, stay_end: FUT_END },
    });
    assert.equal(res.statusCode, 409, res.body);
  });

  test('并发抢占同一空床：仅一个请求成功（事务+行锁+排他约束）', async () => {
    await importRows(cid, [
      row('抢床X', `T-${randomUUID().slice(0, 8)}`),
      row('抢床Y', `T-${randomUUID().slice(0, 8)}`),
    ]);
    const unassigned = await getParticipants(cid, 'registered');
    assert.ok(unassigned.length >= 2);
    const free = await pool.query<{ id: string }>(
      `SELECT b.id FROM beds b
       WHERE b.monk_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM ceremony_bed_stays s
           WHERE s.bed_id=b.id AND s.status<>'released'
             AND daterange(s.stay_start,s.stay_end,'[]') && daterange($1,$2,'[]'))
       LIMIT 1`,
      [FUTURE, FUT_END],
    );
    const target = free.rows[0].id;
    const [r1, r2] = await Promise.all([
      app.inject({
        method: 'PUT',
        url: `/api/ceremonies/${cid}/participants/${unassigned[0].id}/bed`,
        payload: { bed_id: target, stay_start: FUTURE, stay_end: FUT_END },
      }),
      app.inject({
        method: 'PUT',
        url: `/api/ceremonies/${cid}/participants/${unassigned[1].id}/bed`,
        payload: { bed_id: target, stay_start: FUTURE, stay_end: FUT_END },
      }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort((x, y) => x - y);
    assert.deepEqual(codes, [200, 409],
      `got ${r1.statusCode}/${r2.statusCode}: ${r1.body} ${r2.body}`);
  });

  test('数据库层：直接插入重叠区间被 GiST 排他约束拒绝', async () => {
    const occStay = await pool.query<{ bed_id: string; participant_id: string }>(
      `SELECT bed_id, participant_id FROM ceremony_bed_stays
       WHERE ceremony_id=$1 AND status<>'released' LIMIT 1`,
      [cid],
    );
    assert.ok(occStay.rows[0]);
    const other = await pool.query<{ id: string }>(
      `SELECT id FROM ceremony_participants WHERE ceremony_id=$1 AND id<>$2 LIMIT 1`,
      [cid, occStay.rows[0].participant_id],
    );
    await assert.rejects(
      pool.query(
        `INSERT INTO ceremony_bed_stays (ceremony_id, participant_id, bed_id, stay_start, stay_end)
         VALUES ($1,$2,$3,$4,$5)`,
        [cid, other.rows[0].id, occStay.rows[0].bed_id, MID, FUT_END],
      ),
      /cbs_bed_no_overlap/,
    );
  });

  after(async () => cleanupCeremony(cid));
});

describe('候补 FIFO、释放递补与知客确认', () => {
  let cid = '';

  test('满员 2 人，导入 4 人 → 2 登记 2 候补', async () => {
    cid = await makeCeremony(2);
    const r = await importRows(cid, [
      row('候补A', `T-${randomUUID().slice(0, 8)}`),
      row('候补B', `T-${randomUUID().slice(0, 8)}`),
      row('候补C', `T-${randomUUID().slice(0, 8)}`),
      row('候补D', `T-${randomUUID().slice(0, 8)}`),
    ]);
    assert.equal(r.accepted_count, 2);
    assert.equal(r.waitlisted_count, 2);
  });

  test('自动分床 2 位登记者', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/ceremonies/${cid}/allocate-beds`, payload: {} });
    assert.equal((res.json() as { allocated: unknown[] }).allocated.length, 2);
  });

  test('一人未到释放床位 → 队首自动 bed_offered（held，待确认）', async () => {
    const confirmed = await getParticipants(cid, 'confirmed');
    assert.equal(confirmed.length, 2);
    const res = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${cid}/no-show`,
      payload: { participant_ids: [confirmed[0].id], date: FUTURE },
    });
    assert.equal(res.statusCode, 200, res.body);
    const promoted = res.json() as { promoted: { dharma_name: string }[] };
    assert.equal(promoted.promoted.length, 1);
    const offered = await getParticipants(cid, 'bed_offered');
    assert.equal(offered.length, 1);
    assert.equal(offered[0].stay_status, 'held');
  });

  test('知客确认后 stay 转 confirmed、人员 confirmed', async () => {
    const offered = await getParticipants(cid, 'bed_offered');
    assert.ok(offered[0]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${cid}/participants/${offered[0].id}/offer/confirm`,
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const chk = await pool.query(`SELECT status FROM ceremony_participants WHERE id=$1`, [offered[0].id]);
    assert.equal(chk.rows[0].status, 'confirmed');
  });

  test('再释放一床 → 下一位候补递补；谢绝后回候补队尾', async () => {
    const confirmed = await getParticipants(cid, 'confirmed');
    assert.ok(confirmed.length >= 1);
    const rel = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${cid}/no-show`,
      payload: { participant_ids: [confirmed[0].id], date: FUTURE },
    });
    assert.equal(rel.statusCode, 200, rel.body);
    const promoted = rel.json() as { promoted: { participant_id: string }[] };
    assert.equal(promoted.promoted.length, 1);
    const pid = promoted.promoted[0].participant_id;
    const reject = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${cid}/participants/${pid}/offer/reject`,
      payload: {},
    });
    assert.equal(reject.statusCode, 200);
    const back = await pool.query(`SELECT status FROM ceremony_participants WHERE id=$1`, [pid]);
    assert.equal(back.rows[0].status, 'waitlisted');
  });

  after(async () => cleanupCeremony(cid));
});

describe('签到 / 迟到 / 提前离寺与统计', () => {
  let cid = '';

  test('准备法会 5 人并全部分床', async () => {
    cid = await makeCeremony(5);
    await importRows(cid, [
      row('签到甲', `T-${randomUUID().slice(0, 8)}`),
      row('签到乙', `T-${randomUUID().slice(0, 8)}`),
      row('早退丙', `T-${randomUUID().slice(0, 8)}`),
    ]);
    await app.inject({ method: 'POST', url: `/api/ceremonies/${cid}/allocate-beds`, payload: {} });
    const confirmed = await getParticipants(cid, 'confirmed');
    assert.equal(confirmed.length, 3);
  });

  test('批量签到：如期/迟到按日期自动判定', async () => {
    const all = await getParticipants(cid, 'confirmed');
    const [jia, yi] = all;
    const res = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${cid}/checkin`,
      payload: { participant_ids: [jia.id], date: jia.arrive_date },
    });
    const body1 = res.json() as { total: number; on_time: number; late: number };
    assert.equal(body1.total, 1);
    assert.equal(body1.on_time, 1);
    assert.equal(body1.late, 0);
    const lateDate = (() => {
      const d = new Date(yi.arrive_date);
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10);
    })();
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${cid}/checkin`,
      payload: { participant_ids: [yi.id], date: lateDate },
    });
    assert.equal((res2.json() as { late: number }).late, 1);
    assert.equal((res2.json() as { on_time: number }).on_time, 0);
  });

  test('未签到者提前离寺 → 409', async () => {
    const confirmed = await getParticipants(cid, 'confirmed');
    assert.ok(confirmed[0]);
    const res = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${cid}/early-leave`,
      payload: { participant_ids: [confirmed[0].id], date: MID },
    });
    assert.equal(res.statusCode, 409);
  });

  test('加满容量产生候补；签到者提前离寺释放床位并自动递补', async () => {
    const r = await importRows(cid, [
      row('签到丁', `T-${randomUUID().slice(0, 8)}`, FUTURE, FUT_END),
      row('候补戊', `T-${randomUUID().slice(0, 8)}`, FUTURE, FUT_END),
      row('候补己', `T-${randomUUID().slice(0, 8)}`, FUTURE, FUT_END),
    ]);
    // 当前在名额内 3 人，容量 5：丁/戊 accepted，己 waitlisted
    assert.equal(r.row_results.map((x) => x.status).at(-1), 'waitlisted');
    const checkedIn = await getParticipants(cid, 'checked_in');
    assert.ok(checkedIn.length >= 1);
    const res = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${cid}/early-leave`,
      payload: { participant_ids: [checkedIn[0].id], date: MID },
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json() as { total: number; promoted: unknown[] };
    assert.equal(body.total, 1);
    assert.ok(body.promoted.length >= 1);
  });

  test('实到率 / 床位峰值 / 每日入住趋势', async () => {
    const rep = await app.inject({ method: 'GET', url: `/api/ceremonies/${cid}/reports` });
    assert.equal(rep.statusCode, 200);
    const d = rep.json() as {
      arrived_total: number; arrived_rate: number; bed_peak: number;
      bed_peak_date: string | null;
      daily_occupancy: { date: string; beds_occupied: number }[];
    };
    assert.ok(d.arrived_total >= 2);
    assert.ok(d.arrived_rate > 0 && d.arrived_rate <= 100);
    assert.ok(d.bed_peak >= 1);
    assert.ok(d.daily_occupancy.length >= 5);
    assert.equal(d.bed_peak, Math.max(...d.daily_occupancy.map((x) => x.beds_occupied)));
  });

  test('圆满结束批量释放床位，峰值仍可统计（released 历史保留）', async () => {
    const before = (await app.inject({ method: 'GET', url: `/api/ceremonies/${cid}/reports` })).json() as { bed_peak: number };
    const res = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${cid}/release-all`,
      payload: { date: FUT_END },
    });
    assert.equal(res.statusCode, 200);
    const activeStays = await pool.query(
      `SELECT count(*)::int n FROM ceremony_bed_stays WHERE ceremony_id=$1 AND status<>'released'`,
      [cid],
    );
    assert.equal(activeStays.rows[0].n, 0);
    const after = (await app.inject({ method: 'GET', url: `/api/ceremonies/${cid}/reports` })).json() as { bed_peak: number };
    assert.equal(after.bed_peak, before.bed_peak);
  });

  after(async () => cleanupCeremony(cid));
});

describe('临时人员与原有考勤/考察系统隔离', () => {
  test('临时人员不进入 monks 表', async () => {
    const before = await pool.query(`SELECT count(*)::int n FROM monks`);
    const cid = await makeCeremony(3);
    await importRows(cid, [row('隔离僧', `T-${randomUUID().slice(0, 8)}`)]);
    const after = await pool.query(`SELECT count(*)::int n FROM monks`);
    assert.equal(before.rows[0].n, after.rows[0].n);
    await cleanupCeremony(cid);
  });

  test('临时人员不出现在早晚课考勤名册', async () => {
    const cid = await makeCeremony(3);
    await importRows(cid, [row('隔离考勤僧', `T-${randomUUID().slice(0, 8)}`)]);
    const roster = await app.inject({
      method: 'GET',
      url: `/api/attendance?attend_date=${FUTURE}&session=morning`,
    });
    const rows = roster.json() as { monk_id: string }[];
    const cp = await pool.query(`SELECT id FROM ceremony_participants WHERE ceremony_id=$1`, [cid]);
    const tempIds = new Set(cp.rows.map((x: { id: string }) => x.id));
    assert.ok(!rows.some((x) => tempIds.has(x.monk_id)));
    await cleanupCeremony(cid);
  });

  test('操作留痕完整：创建/导入/分床均可查询', async () => {
    const cid = await makeCeremony(2);
    await importRows(cid, [row('留痕僧', `T-${randomUUID().slice(0, 8)}`)]);
    await app.inject({ method: 'POST', url: `/api/ceremonies/${cid}/allocate-beds`, payload: {} });
    const ev = await app.inject({ method: 'GET', url: `/api/ceremonies/${cid}/events` });
    assert.equal(ev.statusCode, 200);
    const types = (ev.json() as { event_type: string }[]).map((x) => x.event_type);
    assert.ok(types.includes('create'));
    assert.ok(types.includes('import'));
    assert.ok(types.includes('allocate'));
    await cleanupCeremony(cid);
  });
});
