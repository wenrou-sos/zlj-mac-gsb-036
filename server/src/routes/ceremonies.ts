import type { FastifyPluginAsync } from 'fastify';
import {
  pool, many, one, ApiError, asEnum,
  CEREMONY_STATUSES, PARTICIPANT_STATUSES, ADMITTED_STATUSES,
} from '../db.js';
import type { ParticipantStatus } from '../db.js';
import type { PoolClient, QueryResultRow } from 'pg';

// =====================================================================
// 大型法会临时僧众管理
// =====================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(v: unknown): v is string {
  return typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}
function shiftDay(d: string, n: number) {
  const dt = new Date(`${d}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

async function writeLog(
  client: PoolClient, ceremonyId: string, action: string, detail: Record<string, unknown>,
  opts: { participantId?: string | null; batchNo?: number | null; operator?: string } = {},
) {
  await client.query(
    `INSERT INTO ceremony_event_log (ceremony_id, participant_id, batch_no, action, detail, operator)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
    [ceremonyId, opts.participantId ?? null, opts.batchNo ?? null,
     action, JSON.stringify(detail ?? {}), opts.operator ?? '知客'],
  );
}

// 所有名额/候补/床位操作先锁法会行，串行化，杜绝并发抢占
async function lockCeremony(client: PoolClient, id: string, allowed: readonly string[] = CEREMONY_STATUSES) {
  const { rows } = await client.query(`SELECT * FROM ceremonies WHERE id=$1 FOR UPDATE`, [id]);
  if (rows.length === 0) throw new ApiError(404, '法会不存在');
  if (!allowed.includes(rows[0].status)) {
    throw new ApiError(409, `法会当前状态不允许此操作`);
  }
  return rows[0] as QueryResultRow;
}

// 在寺占用的有效离寺日：提前离寺者以实际离寺日截断（人天名额随之释放）
const EFF_LEAVE = `LEAST(p.leave_date, COALESCE(p.actual_leave_date, p.leave_date))`;

// [arrive,leave) 区间内首个超限日期，否则 undefined
async function firstOverCapacityDay(
  client: PoolClient, ceremonyId: string, arrive: string, leave: string, cap: number,
): Promise<{ day: string; n: number } | undefined> {
  const r = await client.query(
    `WITH days(d) AS (
       SELECT generate_series($2::date, $3::date - 1, INTERVAL '1 day')::date
     )
     SELECT d.d::text AS day,
            (SELECT count(*) FROM ceremony_participants p
              WHERE p.ceremony_id=$1
                AND p.status = ANY($4::ceremony_participant_status[])
                AND p.arrive_date <= d.d AND ${EFF_LEAVE} > d.d)::int AS n
       FROM days d
      WHERE (SELECT count(*) FROM ceremony_participants p
              WHERE p.ceremony_id=$1
                AND p.status = ANY($4::ceremony_participant_status[])
                AND p.arrive_date <= d.d AND ${EFF_LEAVE} > d.d) >= $5
      ORDER BY d.d LIMIT 1`,
    [ceremonyId, arrive, leave, ADMITTED_STATUSES, cap],
  );
  return r.rows[0] as { day: string; n: number } | undefined;
}

// 同一僧人日期撞期：其他法会有效记录 / 现有在寺挂单
async function dateConflict(
  client: PoolClient, monkId: string, arrive: string, leave: string, ceremonyId: string,
): Promise<string | null> {
  const other = await client.query(
    `SELECT c.name, p.arrive_date, p.leave_date
       FROM ceremony_participants p JOIN ceremonies c ON c.id=p.ceremony_id
      WHERE p.monk_id=$1 AND p.ceremony_id <> $4
        AND p.status NOT IN ('cancelled','no_show')
        AND p.arrive_date < $3
        AND LEAST(p.leave_date, COALESCE(p.actual_leave_date, p.leave_date)) > $2
      LIMIT 1`,
    [monkId, arrive, leave, ceremonyId],
  );
  if (other.rows[0]) {
    const x = other.rows[0];
    return `与法会「${x.name}」(${x.arrive_date}~${x.leave_date})日期撞期`;
  }
  const guadan = await client.query(
    `SELECT 1 FROM guadan g
      WHERE g.monk_id=$1 AND g.status='active'
        AND g.arrive_date < $3 AND (g.arrive_date + g.expected_days) > $2
      LIMIT 1`,
    [monkId, arrive, leave],
  );
  return guadan.rows[0] ? '与该僧人现有在寺挂单日期重叠' : null;
}

// 在 arrive~leave（含离寺日）全程空闲的床位；preferRoomIds 内房间优先（同组聚住）
async function findBed(
  client: PoolClient, arrive: string, leave: string, preferRoomIds: string[] = [],
) {
  const r = await client.query(
    `SELECT b.id AS bed_id, b.bed_no, r.id AS room_id, r.room_no
       FROM beds b JOIN rooms r ON r.id=b.room_id
      WHERE b.monk_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ceremony_bed_assignments a
           WHERE a.bed_id=b.id AND a.status='active'
             AND a.stay_range && daterange($1::date, $2::date)
        )
      ORDER BY CASE WHEN r.id = ANY($3::uuid[]) THEN 0 ELSE 1 END,
               r.room_no, b.bed_no
      LIMIT 1`,
    [arrive, shiftDay(leave, 1), preferRoomIds],
  );
  return r.rows[0] as { bed_id: string; bed_no: string; room_id: string; room_no: string } | undefined;
}

// 释放某人员当前床位（离寺场景整段释放），返回被释放行
async function releaseParticipantBeds(
  client: PoolClient, participantId: string, reason: string,
): Promise<QueryResultRow[]> {
  const { rows } = await client.query(
    `SELECT * FROM ceremony_bed_assignments WHERE participant_id=$1 AND status='active' FOR UPDATE`,
    [participantId],
  );
  for (const a of rows) {
    await client.query(
      `UPDATE ceremony_bed_assignments SET status='released', released_at=now(), released_reason=$2
        WHERE id=$1`,
      [a.id, reason],
    );
  }
  return rows;
}

// 从候补队首递补：最早候选 + 名额可纳 + 床位可分；占用床位进入 proposed 待确认。
// 若名额要等到某个释放日才空出，则从该日起接纳（缩短在寺区间并留痕）。
async function promoteFromWaitlist(
  client: PoolClient, ceremonyId: string, operator = '知客',
): Promise<QueryResultRow | null> {
  const capRow = await client.query(`SELECT daily_capacity FROM ceremonies WHERE id=$1`, [ceremonyId]);
  const cap = capRow.rows[0].daily_capacity as number;
  const candidates = await client.query(
    `SELECT * FROM ceremony_participants
      WHERE ceremony_id=$1 AND status='waitlisted'
      ORDER BY created_at, id`,
    [ceremonyId],
  );
  for (const cand of candidates.rows) {
    // 计算从哪天起至离寺每天名额都够
    const feasibleFrom = (await client.query(
      `WITH days(d) AS (
         SELECT generate_series($2::date, $3::date - 1, INTERVAL '1 day')::date
       )
       SELECT min(d.d)::text AS d FROM days d
        WHERE NOT EXISTS (
          SELECT 1 FROM days x
           WHERE x.d >= d.d AND x.d < $3::date
             AND (SELECT count(*) FROM ceremony_participants p
                   WHERE p.ceremony_id=$1
                     AND p.status = ANY($4::ceremony_participant_status[])
                     AND p.arrive_date <= x.d
                     AND LEAST(p.leave_date, COALESCE(p.actual_leave_date, p.leave_date)) > x.d) >= $5
        )`,
      [ceremonyId, cand.arrive_date, cand.leave_date, ADMITTED_STATUSES, cap],
    )).rows[0].d as string | null;
    if (!feasibleFrom) continue; // 整个区间都无名额
    const bed = await findBed(client, feasibleFrom, cand.leave_date);
    if (!bed) continue;
    if (feasibleFrom !== cand.arrive_date) {
      await client.query(`UPDATE ceremony_participants SET arrive_date=$2 WHERE id=$1`, [cand.id, feasibleFrom]);
    }
    await client.query(
      `INSERT INTO ceremony_bed_assignments
        (ceremony_id, participant_id, bed_id, stay_range, assignment_type, status, assigned_by)
       VALUES ($1,$2,$3,daterange($4::date,$5::date + 1),'promoted','active',$6)`,
      [ceremonyId, cand.id, bed.bed_id, feasibleFrom, cand.leave_date, operator],
    );
    await client.query(`UPDATE ceremony_participants SET status='proposed' WHERE id=$1`, [cand.id]);
    await writeLog(client, ceremonyId, 'promote', {
      participant_id: cand.id, dharma_name: cand.dharma_name,
      bed: `${bed.room_no} · ${bed.bed_no}床`, reason: '床位释放自动递补',
      requested_arrive: cand.arrive_date,
      admitted_arrive: feasibleFrom,
      truncated: feasibleFrom !== cand.arrive_date,
    }, { participantId: cand.id, operator });
    return cand;
  }
  return null;
}

// 实到率 / 床位峰值 / 每日入住趋势
async function computeStats(client: PoolClient, ceremonyId: string) {
  const c = (await client.query(`SELECT start_date, end_date FROM ceremonies WHERE id=$1`, [ceremonyId])).rows[0];
  const daily = await client.query(
    `WITH days(d) AS (
       SELECT generate_series($2::date, $3::date, INTERVAL '1 day')::date
     )
     SELECT d.d::text AS day,
            (SELECT count(*) FROM ceremony_participants p
              WHERE p.ceremony_id=$1
                AND p.status = ANY(ARRAY['checked_in','late','early_left','left']
                                  ::ceremony_participant_status[])
                AND p.arrive_date <= d.d
                AND LEAST(p.leave_date, COALESCE(p.actual_leave_date, p.leave_date)) > d.d)::int AS present,
            (SELECT count(*) FROM ceremony_participants p
              WHERE p.ceremony_id=$1
                AND p.status = ANY(ARRAY['registered','proposed','checked_in','late','early_left','left']
                                  ::ceremony_participant_status[])
                AND p.arrive_date <= d.d
                AND LEAST(p.leave_date, COALESCE(p.actual_leave_date, p.leave_date)) > d.d)::int AS admitted,
            (SELECT count(DISTINCT a.bed_id) FROM ceremony_bed_assignments a
              WHERE a.ceremony_id=$1 AND a.status='active'
                AND a.stay_range @> d.d)::int AS beds_used
       FROM days d ORDER BY d.d`,
    [ceremonyId, c.start_date, c.end_date],
  );
  const totals = (await client.query(
    `SELECT
        count(*) FILTER (WHERE status = ANY(ARRAY['registered','proposed','checked_in','late','early_left','left']
                                            ::ceremony_participant_status[]))::int AS admitted,
        count(*) FILTER (WHERE status = ANY(ARRAY['checked_in','late','early_left','left']
                                            ::ceremony_participant_status[]))::int AS arrived,
        count(*) FILTER (WHERE status='no_show')::int AS no_show,
        count(*) FILTER (WHERE status='waitlisted')::int AS waitlisted
       FROM ceremony_participants WHERE ceremony_id=$1`,
    [ceremonyId],
  )).rows[0];
  const trend = daily.rows as { day: string; present: number; admitted: number; beds_used: number }[];
  return {
    admitted: totals.admitted,
    arrived: totals.arrived,
    no_show: totals.no_show,
    waitlisted: totals.waitlisted,
    arrival_rate: totals.admitted ? Number((totals.arrived / totals.admitted * 100).toFixed(1)) : 100,
    bed_peak: trend.reduce((m, r) => Math.max(m, r.beds_used), 0),
    daily: trend,
  };
}

interface ImportRow {
  dharma_name: string; home_monastery: string | null; ordination_no: string | null;
  arrive_date: string; leave_date: string; special_need: string | null;
}

const routes: FastifyPluginAsync = async (app) => {
  // ==================== 法会 ====================
  app.get('/', async () => many(`
    SELECT c.*,
      (SELECT count(*) FROM ceremony_participants p
        WHERE p.ceremony_id=c.id
          AND p.status = ANY(ARRAY['registered','proposed','checked_in','late','early_left','left']
                            ::ceremony_participant_status[]))::int AS admitted_count,
      (SELECT count(*) FROM ceremony_participants p
        WHERE p.ceremony_id=c.id AND p.status='waitlisted')::int AS waitlist_count,
      (SELECT count(*) FROM ceremony_participants p
        WHERE p.ceremony_id=c.id AND p.status='checked_in')::int AS checkedin_count
    FROM ceremonies c
    ORDER BY c.start_date DESC, c.created_at DESC
  `));

  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const r = await one(`SELECT * FROM ceremonies WHERE id=$1`, [req.params.id]);
    if (!r) throw new ApiError(404, '法会不存在');
    return r;
  });

  app.post('/', async (req, reply) => {
    const { name, start_date, end_date, daily_capacity, note } = req.body as {
      name?: string; start_date?: string; end_date?: string;
      daily_capacity?: number; note?: string | null;
    };
    if (!name?.trim()) throw new ApiError(400, '法会名称不能为空');
    if (!isDate(start_date)) throw new ApiError(400, '开始日期格式应为 YYYY-MM-DD');
    if (!isDate(end_date)) throw new ApiError(400, '结束日期格式应为 YYYY-MM-DD');
    if (end_date < start_date) throw new ApiError(400, '结束日期不能早于开始日期');
    if (!daily_capacity || daily_capacity <= 0) throw new ApiError(400, '每日接待上限必须为正整数');
    const row = await one(
      `INSERT INTO ceremonies (name, start_date, end_date, daily_capacity, note)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [name.trim(), start_date, end_date, daily_capacity, note ?? null],
    );
    return reply.code(201).send(row);
  });

  // 仅筹备中可改；收窄容量不得低于当前人天峰值
  app.put<{ Params: { id: string } }>('/:id', async (req) => {
    const body = req.body as {
      name?: string; start_date?: string; end_date?: string;
      daily_capacity?: number; note?: string | null;
    };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = await lockCeremony(client, req.params.id, ['preparing']);
      const sd = body.start_date ?? c.start_date;
      const ed = body.end_date ?? c.end_date;
      const cap = body.daily_capacity ?? c.daily_capacity;
      if (!isDate(sd) || !isDate(ed)) throw new ApiError(400, '日期格式应为 YYYY-MM-DD');
      if (ed < sd) throw new ApiError(400, '结束日期不能早于开始日期');
      if (!(Number(cap) > 0)) throw new ApiError(400, '每日接待上限必须为正整数');
      const peak = await client.query(
        `WITH days(d) AS (
           SELECT generate_series($2::date, $3::date - 1, INTERVAL '1 day')::date
         )
         SELECT max((SELECT count(*) FROM ceremony_participants p
                      WHERE p.ceremony_id=$1
                        AND p.status = ANY(ARRAY['registered','proposed','checked_in','late','early_left','left']
                                          ::ceremony_participant_status[])
                        AND p.arrive_date <= d
                        AND LEAST(p.leave_date, COALESCE(p.actual_leave_date, p.leave_date)) > d))::int AS peak
           FROM days`,
        [req.params.id, sd, ed],
      );
      if ((peak.rows[0].peak ?? 0) > cap) {
        throw new ApiError(409, `区间内已有 ${peak.rows[0].peak} 人/天，接待上限不可低于该数`);
      }
      const row = await one(
        `UPDATE ceremonies SET name=COALESCE($2,name), start_date=$3, end_date=$4,
           daily_capacity=$5, note=COALESCE($6,note)
         WHERE id=$1 RETURNING *`,
        [req.params.id, body.name?.trim() ?? null, sd, ed, cap, body.note ?? null],
      );
      await client.query('COMMIT');
      return row;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 开始 / 圆满
  app.post<{ Params: { id: string; action: string } }>('/:id/:action(start|close)', async (req) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (req.params.action === 'start') {
        await lockCeremony(client, req.params.id, ['preparing']);
        await writeLog(client, req.params.id, 'start', {});
        const row = (await client.query(
          `UPDATE ceremonies SET status='active' WHERE id=$1 RETURNING *`,
          [req.params.id],
        )).rows[0];
        await client.query('COMMIT');
        return row;
      }
      await lockCeremony(client, req.params.id, ['preparing', 'active']);
      const stats = await computeStats(client, req.params.id);
      // 未签到者按未到处理；在寺者置圆满离寺；床位批量释放
      await client.query(
        `UPDATE ceremony_participants
            SET status=CASE
                  WHEN status IN ('registered','proposed') THEN 'no_show'
                  WHEN status IN ('checked_in','late') THEN 'left'
                  ELSE status END,
                actual_leave_date=CASE
                  WHEN status IN ('checked_in','late')
                    THEN COALESCE(actual_leave_date, CURRENT_DATE)
                  ELSE actual_leave_date END
          WHERE ceremony_id=$1
            AND status NOT IN ('no_show','early_left','left','cancelled','waitlisted')`,
        [req.params.id],
      );
      await client.query(
        `UPDATE ceremony_bed_assignments SET status='released', released_at=now(), released_reason='close'
          WHERE ceremony_id=$1 AND status='active'`,
        [req.params.id],
      );
      await client.query(
        `UPDATE ceremonies SET status='closed', closed_at=now(), final_stats=$2 WHERE id=$1`,
        [req.params.id, JSON.stringify(stats)],
      );
      await writeLog(client, req.params.id, 'close', { stats });
      await client.query('COMMIT');
      return { ok: true, stats };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // ==================== 人员 ====================
  app.get<{ Params: { id: string } }>('/:id/participants', async (req) => {
    const { status, q } = req.query as { status?: string; q?: string };
    const conds = ['p.ceremony_id=$1'];
    const params: unknown[] = [req.params.id];
    if (status) {
      params.push(asEnum(status, PARTICIPANT_STATUSES, '人员状态'));
      conds.push(`p.status=$${params.length}::ceremony_participant_status`);
    }
    if (q?.trim()) {
      params.push(`%${q.trim()}%`);
      conds.push(`(p.dharma_name ILIKE $${params.length} OR p.ordination_no ILIKE $${params.length})`);
    }
    return many(`
      SELECT p.*, r.room_no, b.bed_no
      FROM ceremony_participants p
      LEFT JOIN ceremony_bed_assignments a
        ON a.participant_id=p.id AND a.status='active'
      LEFT JOIN beds b ON b.id=a.bed_id
      LEFT JOIN rooms r ON r.id=b.room_id
      WHERE ${conds.join(' AND ')}
      ORDER BY CASE p.status
                 WHEN 'checked_in' THEN 0 WHEN 'late' THEN 1 WHEN 'proposed' THEN 2
                 WHEN 'registered' THEN 3 WHEN 'waitlisted' THEN 4
                 WHEN 'early_left' THEN 5 WHEN 'left' THEN 6
                 WHEN 'no_show' THEN 7 ELSE 8 END,
               p.arrive_date, p.created_at
    `, params);
  });

  // 表格批量导入：逐行反馈 duplicate / conflict / capacity / ok
  app.post<{ Params: { id: string } }>('/:id/import', async (req) => {
    const ceremonyId = req.params.id;
    const body = req.body as { rows?: Record<string, unknown>[]; operator?: string };
    if (!Array.isArray(body.rows) || body.rows.length === 0) {
      throw new ApiError(400, '未提供导入数据行');
    }
    const operator = body.operator?.trim() || '知客';

    const pick = (raw: Record<string, unknown>, keys: string[]) => {
      for (const k of keys) {
        const v = raw[k];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };
    const parsed: (ImportRow & { line_no: number })[] = [];
    for (let i = 0; i < body.rows.length; i++) {
      const raw = body.rows[i];
      parsed.push({
        line_no: i + 1,
        dharma_name: pick(raw, ['法名', 'dharma_name', 'name']),
        home_monastery: pick(raw, ['出家寺庙', '寺庙', 'home_monastery', 'monastery']) || null,
        ordination_no: pick(raw, ['戒牒编号', '戒牒', 'ordination_no']) || null,
        arrive_date: pick(raw, ['到寺日期', '到寺', 'arrive_date', 'arrive']),
        leave_date: pick(raw, ['离寺日期', '离寺', '预计离寺', 'leave_date', 'leave']),
        special_need: pick(raw, ['特殊需求', '需求', 'special_need', 'need']) || null,
      });
    }

    const client = await pool.connect();
    const results: Record<string, unknown>[] = [];
    let imported = 0;
    let waitlisted = 0;
    try {
      await client.query('BEGIN');
      const ceremony = await lockCeremony(client, ceremonyId, ['preparing', 'active']);
      const cap = ceremony.daily_capacity as number;
      const batchNo = (await client.query(
        `SELECT COALESCE(max(batch_no),0)+1 AS n FROM ceremony_event_log WHERE ceremony_id=$1`,
        [ceremonyId],
      )).rows[0].n as number;

      const inBatch = new Set<string>();

      for (const row of parsed) {
        const base = {
          line_no: row.line_no, dharma_name: row.dharma_name,
          ordination_no: row.ordination_no,
          arrive_date: row.arrive_date, leave_date: row.leave_date,
        };
        const fail = (code: string, message: string) =>
          results.push({ ...base, result: 'error', code, message });

        if (!row.dharma_name) { fail('invalid', '法名不能为空'); continue; }
        if (!isDate(row.arrive_date) || !isDate(row.leave_date)) {
          fail('invalid', '到/离寺日期格式应为 YYYY-MM-DD'); continue;
        }
        if (row.leave_date < row.arrive_date) { fail('invalid', '离寺日期早于到寺日期'); continue; }
        if (row.arrive_date < ceremony.start_date || row.leave_date > shiftDay(ceremony.end_date, 1)) {
          fail('invalid', `到离寺时间超出法会期间（${ceremony.start_date} ~ ${ceremony.end_date}）`);
          continue;
        }
        const key = row.ordination_no
          ? `ord:${row.ordination_no}`
          : `name:${row.dharma_name}|${row.arrive_date}|${row.leave_date}`;
        if (inBatch.has(key)) { fail('duplicate', '与本次导入中前面的行重复'); continue; }
        inBatch.add(key);

        // 同法会重复：戒牒号（或同法名+日期）
        const dupSql = row.ordination_no
          ? `SELECT id FROM ceremony_participants
             WHERE ceremony_id=$1 AND ordination_no=$2
               AND status <> 'cancelled' LIMIT 1`
          : `SELECT id FROM ceremony_participants
             WHERE ceremony_id=$1 AND dharma_name=$2
               AND arrive_date=$3 AND leave_date=$4
               AND status <> 'cancelled' LIMIT 1`;
        const dupParams = row.ordination_no
          ? [ceremonyId, row.ordination_no]
          : [ceremonyId, row.dharma_name, row.arrive_date, row.leave_date];
        const dup = await client.query(dupSql, dupParams);
        if (dup.rows[0]) { fail('duplicate', '该人员已在此法会名单中（戒牒/法名重复）'); continue; }

        // 建立或复用临时僧人档（戒牒号匹配历史法会临时人员）
        let monkId: string | null = null;
        if (row.ordination_no) {
          const ex = await client.query(
            `SELECT m.id FROM monks m
              JOIN ceremony_participants p ON p.monk_id=m.id
             WHERE m.ordination_no=$1
             ORDER BY p.created_at DESC LIMIT 1`,
            [row.ordination_no],
          );
          if (ex.rows[0]) monkId = ex.rows[0].id as string;
        }
        if (!monkId) {
          const ins = await client.query(
            `INSERT INTO monks (dharma_name, home_monastery, ordination_no, status)
             VALUES ($1,$2,$3,'ceremony') RETURNING id`,
            [row.dharma_name, row.home_monastery, row.ordination_no],
          );
          monkId = ins.rows[0].id as string;
        } else {
          const conflict = await dateConflict(client, monkId, row.arrive_date, row.leave_date, ceremonyId);
          if (conflict) { fail('conflict', conflict); continue; }
        }

        // 接待容量：任何一天超限则入候补
        const over = await firstOverCapacityDay(client, ceremonyId, row.arrive_date, row.leave_date, cap);
        const groupKey = `${row.arrive_date}~${row.leave_date}|${row.special_need ?? ''}`;
        const status = over ? 'waitlisted' : 'registered';
        const insP = await client.query(
          `INSERT INTO ceremony_participants
             (ceremony_id, monk_id, dharma_name, home_monastery, ordination_no,
              group_key, arrive_date, leave_date, special_need, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::ceremony_participant_status)
           RETURNING id`,
          [ceremonyId, monkId, row.dharma_name, row.home_monastery, row.ordination_no,
           groupKey, row.arrive_date, row.leave_date, row.special_need, status],
        );
        const pid = insP.rows[0].id as string;
        await writeLog(client, ceremonyId, 'import', {
          dharma_name: row.dharma_name, ordination_no: row.ordination_no,
          arrive_date: row.arrive_date, leave_date: row.leave_date,
          special_need: row.special_need, home_monastery: row.home_monastery,
          result: over ? 'waitlisted' : 'imported',
          ...(over ? { over_day: over.day, over_count: over.n + 1, capacity: cap } : {}),
        }, { participantId: pid, batchNo, operator });

        if (over) {
          waitlisted++;
          results.push({
            ...base, participant_id: pid, result: 'waitlisted',
            message: `${over.day} 接待已满（上限 ${cap} 人），已列入候补第 ${waitlisted} 位`,
          });
        } else {
          imported++;
          results.push({ ...base, participant_id: pid, result: 'ok', message: '已导入' });
        }
      }

      await writeLog(client, ceremonyId, 'import_batch', {
        batch_no: batchNo, total: parsed.length, imported, waitlisted,
        errors: results.filter((r) => r.result === 'error').length,
      }, { batchNo, operator });

      await client.query('COMMIT');
      return {
        batch_no: batchNo,
        total: parsed.length,
        imported,
        waitlisted,
        errors: results.filter((r) => r.result === 'error').length,
        results,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 手动新增单人（同导入校验语义）
  app.post<{ Params: { id: string } }>('/:id/participants', async (req, reply) => {
    const body = req.body as ImportRow & { operator?: string };
    const r = await app.inject({
      method: 'POST',
      url: `/api/ceremonies/${req.params.id}/import`,
      payload: { rows: [body], operator: body.operator },
    });
    return reply.code(r.statusCode).send(r.json());
  });

  // 取消候补/登记（释放已占床位并尝试递补）
  app.post<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/cancel', async (req) => {
    const { operator } = req.body as { operator?: string };
    return transition(req.params.id, req.params.pid, ['registered', 'waitlisted', 'proposed'], 'cancelled',
      async (client, p) => {
        if (p.status !== 'waitlisted') await releaseParticipantBeds(client, p.id, 'cancel');
        await writeLog(client, req.params.id, 'cancel', { dharma_name: p.dharma_name },
          { participantId: p.id, operator: operator ?? '知客' });
        if (p.status !== 'waitlisted') await promoteFromWaitlist(client, req.params.id, operator);
      });
  });

  // ==================== 床位 ====================

  // 区间内可用床位（手动调床用；自动分配在事务内调用 findBed）
  app.get<{ Params: { id: string } }>('/:id/available-beds', async (req) => {
    const { arrive, leave } = req.query as { arrive?: string; leave?: string };
    if (!isDate(arrive) || !isDate(leave)) throw new ApiError(400, '请提供到寺与离寺日期');
    if (leave < arrive) throw new ApiError(400, '离寺日期不能早于到寺日期');
    return many(
      `SELECT b.id AS bed_id, b.bed_no, r.id AS room_id, r.room_no
         FROM beds b JOIN rooms r ON r.id=b.room_id
        WHERE b.monk_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM ceremony_bed_assignments a
             WHERE a.bed_id=b.id AND a.status='active'
               AND a.stay_range && daterange($1::date, $2::date)
          )
        ORDER BY r.room_no, b.bed_no`,
      [arrive, shiftDay(leave, 1)],
    );
  });

  // 按到离寺时间+特殊需求分组，批量自动分配临时床位
  app.post<{ Params: { id: string } }>('/:id/auto-assign', async (req) => {
    const { operator } = req.body as { operator?: string };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ceremony = await lockCeremony(client, req.params.id, ['preparing', 'active']);
      void ceremony;
      // 名额内、无 active 床位的已登记人员（候补不参与）
      const people = await client.query(
        `SELECT * FROM ceremony_participants
          WHERE ceremony_id=$1
            AND status = ANY(ARRAY['registered']::ceremony_participant_status[])
            AND NOT EXISTS (SELECT 1 FROM ceremony_bed_assignments a
                             WHERE a.participant_id=ceremony_participants.id AND a.status='active')
          ORDER BY arrive_date, special_need NULLS LAST, created_at`,
        [req.params.id],
      );
      // 分组：group_key -> 人员
      const groups = new Map<string, QueryResultRow[]>();
      for (const p of people.rows) {
        const arr = groups.get(p.group_key) ?? [];
        arr.push(p);
        groups.set(p.group_key, arr);
      }
      let assigned = 0;
      const skipped: { id: string; dharma_name: string; reason: string }[] = [];
      for (const [, members] of groups) {
        // 优先同组已入住房间，保持聚住
        const preferredRooms = (await client.query(
          `SELECT DISTINCT b.room_id
             FROM ceremony_bed_assignments a JOIN beds b ON b.id=a.bed_id
            WHERE a.ceremony_id=$1 AND a.status='active'
              AND a.participant_id = ANY($2::uuid[])`,
          [req.params.id, members.map((m) => m.id)],
        )).rows.map((r) => r.room_id as string);

        for (const p of members) {
          const bed = await findBed(client, p.arrive_date, p.leave_date, preferredRooms);
          if (!bed) {
            skipped.push({ id: p.id, dharma_name: p.dharma_name, reason: '区间内无空闲床位' });
            await writeLog(client, req.params.id, 'auto_assign_skip', {
              dharma_name: p.dharma_name, reason: 'no_bed',
            }, { participantId: p.id, operator: operator ?? '知客' });
            continue;
          }
          try {
            await client.query(
              `INSERT INTO ceremony_bed_assignments
                 (ceremony_id, participant_id, bed_id, stay_range, assignment_type, status, assigned_by)
               VALUES ($1,$2,$3,daterange($4::date,$5::date + 1),'auto','active',$6)`,
              [req.params.id, p.id, bed.bed_id, p.arrive_date, p.leave_date, operator ?? '知客'],
            );
          } catch (e) {
            // 排他约束冲突（并发抢占）：跳过并留痕
            if ((e as { code?: string }).code === '23P01' || (e as Error).message?.includes('cba_bed_overlap')) {
              skipped.push({ id: p.id, dharma_name: p.dharma_name, reason: '床位被并发占用' });
              continue;
            }
            throw e;
          }
          preferredRooms.push(bed.room_id);
          assigned++;
          await writeLog(client, req.params.id, 'auto_assign', {
            dharma_name: p.dharma_name, bed: `${bed.room_no} · ${bed.bed_no}床`,
            group_key: p.group_key,
          }, { participantId: p.id, operator: operator ?? '知客' });
        }
      }
      await client.query('COMMIT');
      return { ok: true, assigned, skipped: skipped.length, skipped_detail: skipped };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 调床：事务 + 排他约束防并发抢占
  app.put<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/bed', async (req) => {
    const { bed_id, operator } = req.body as { bed_id?: string; operator?: string };
    if (!bed_id) throw new ApiError(400, '请选择目标床位');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockCeremony(client, req.params.id, ['preparing', 'active']);
      const p = (await client.query(
        `SELECT * FROM ceremony_participants WHERE id=$1 AND ceremony_id=$2
          AND status = ANY(ARRAY['registered','proposed','checked_in','late']
                          ::ceremony_participant_status[]) FOR UPDATE`,
        [req.params.pid, req.params.id],
      )).rows[0];
      if (!p) throw new ApiError(404, '可安排床位的法会人员不存在');
      const target = (await client.query(
        `SELECT b.id, b.bed_no, b.monk_id, r.room_no FROM beds b JOIN rooms r ON r.id=b.room_id
          WHERE b.id=$1 FOR UPDATE`,
        [bed_id],
      )).rows[0];
      if (!target) throw new ApiError(400, '床位不存在');
      if (target.monk_id) throw new ApiError(409, '该床位有常住/挂单僧人入住，不可安排');

      const old = (await client.query(
        `SELECT a.*, r.room_no AS old_room, b.bed_no AS old_bed
           FROM ceremony_bed_assignments a
           JOIN beds b ON b.id=a.bed_id JOIN rooms r ON r.id=b.room_id
          WHERE a.participant_id=$1 AND a.status='active' FOR UPDATE`,
        [p.id],
      )).rows[0];
      // 新占用区间：已签到者从今起，未签到者按到离寺全程
      const rangeStart = p.status === 'checked_in' || p.status === 'late'
        ? (await client.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d
        : p.arrive_date;
      const rangeEnd = p.leave_date;
      if (rangeEnd <= rangeStart) throw new ApiError(409, '人员已过离寺日期，无法调床');

      try {
        await client.query(
          `INSERT INTO ceremony_bed_assignments
             (ceremony_id, participant_id, bed_id, stay_range, assignment_type, status, assigned_by)
           VALUES ($1,$2,$3,daterange($4::date,$5::date + 1),'manual','active',$6)`,
          [req.params.id, p.id, bed_id, rangeStart, rangeEnd, operator ?? '知客'],
        );
      } catch (e) {
        if ((e as { code?: string }).code === '23P01' || (e as Error).message?.includes('cba_bed_overlap')) {
          throw new ApiError(409, '该床位在所选时段已被其他法会人员占用');
        }
        throw e;
      }
      if (old) {
        // 原占用截到调床日（未来段让位）；整段标记 released 留痕
        await client.query(
          `UPDATE ceremony_bed_assignments SET status='released', released_at=now(), released_reason='transfer'
            WHERE id=$1`,
          [old.id],
        );
      }
      await writeLog(client, req.params.id, 'transfer', {
        dharma_name: p.dharma_name,
        from: old ? `${old.old_room} · ${old.old_bed}床` : null,
        to: `${target.room_no} · ${target.bed_no}床`,
      }, { participantId: p.id, operator: operator ?? '知客' });

      // 原床位释放，尝试候补递补
      let promoted: QueryResultRow | null = null;
      if (old) promoted = await promoteFromWaitlist(client, req.params.id, operator);
      await client.query('COMMIT');
      return {
        ok: true,
        bed: `${target.room_no} · ${target.bed_no}床`,
        promoted: promoted ? { id: promoted.id, dharma_name: promoted.dharma_name } : null,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 手动触发候补递补
  app.post<{ Params: { id: string } }>('/:id/promote', async (req) => {
    const { operator } = req.body as { operator?: string };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockCeremony(client, req.params.id, ['preparing', 'active']);
      const cand = await promoteFromWaitlist(client, req.params.id, operator ?? '知客');
      await client.query('COMMIT');
      if (!cand) return { promoted: null, message: '暂无可递补候补（名额或床位不足）' };
      return { promoted: { id: cand.id, dharma_name: cand.dharma_name }, pending_confirm: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 知客确认递补床位（proposed -> registered）
  app.post<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/confirm', async (req) => {
    const { operator } = req.body as { operator?: string };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockCeremony(client, req.params.id, ['preparing', 'active']);
      const p = (await client.query(
        `SELECT * FROM ceremony_participants WHERE id=$1 AND ceremony_id=$2 FOR UPDATE`,
        [req.params.pid, req.params.id],
      )).rows[0];
      if (!p) throw new ApiError(404, '法会人员不存在');
      if (p.status !== 'proposed') throw new ApiError(409, '仅待确认的递补人员可以确认');
      await client.query(`UPDATE ceremony_participants SET status='registered' WHERE id=$1`, [p.id]);
      await writeLog(client, req.params.id, 'promote_confirm', { dharma_name: p.dharma_name },
        { participantId: p.id, operator: operator ?? '知客' });
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 知客拒绝递补：释放床位回候补，继续尝试下一位
  app.post<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/reject', async (req) => {
    const { operator, reason } = req.body as { operator?: string; reason?: string };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockCeremony(client, req.params.id, ['preparing', 'active']);
      const p = (await client.query(
        `SELECT * FROM ceremony_participants WHERE id=$1 AND ceremony_id=$2 FOR UPDATE`,
        [req.params.pid, req.params.id],
      )).rows[0];
      if (!p) throw new ApiError(404, '法会人员不存在');
      if (p.status !== 'proposed') throw new ApiError(409, '仅待确认的递补人员可以拒绝');
      await releaseParticipantBeds(client, p.id, 'reject');
      // 被拒者回到候补队尾（updated_at 记录回队时刻），随后尝试下一位
      await client.query(
        `UPDATE ceremony_participants SET status='waitlisted', created_at=now() WHERE id=$1`,
        [p.id],
      );
      await writeLog(client, req.params.id, 'promote_reject', { dharma_name: p.dharma_name, reason: reason ?? null },
        { participantId: p.id, operator: operator ?? '知客' });
      await promoteFromWaitlist(client, req.params.id, operator);
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // ==================== 签到 / 离寺 ====================
  // 批量签到：on_time / late；默认按到寺日期判定迟到
  app.post<{ Params: { id: string } }>('/:id/checkins/bulk', async (req) => {
    const { participant_ids, action, operator } = req.body as {
      participant_ids?: string[];
      action?: 'checkin' | 'late' | 'no_show';
      operator?: string;
    };
    if (!Array.isArray(participant_ids) || participant_ids.length === 0) throw new ApiError(400, '未选择人员');
    if (!action || !['checkin', 'late', 'no_show'].includes(action)) throw new ApiError(400, '签到动作无效');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockCeremony(client, req.params.id, ['active']);
      let done = 0;
      const skipped: { participant_id: string; reason: string }[] = [];
      for (const pid of participant_ids) {
        const p = (await client.query(
          `SELECT * FROM ceremony_participants WHERE id=$1 AND ceremony_id=$2 FOR UPDATE`,
          [pid, req.params.id],
        )).rows[0];
        if (!p) { skipped.push({ participant_id: pid, reason: 'not_found' }); continue; }
        if (action === 'no_show') {
          if (!['registered', 'proposed', 'waitlisted'].includes(p.status)) {
            skipped.push({ participant_id: pid, reason: `状态${p.status}不可标记未到` });
            continue;
          }
          if (p.status !== 'waitlisted') await releaseParticipantBeds(client, p.id, 'no_show');
          await client.query(`UPDATE ceremony_participants SET status='no_show' WHERE id=$1`, [p.id]);
          await writeLog(client, req.params.id, 'no_show', { dharma_name: p.dharma_name },
            { participantId: p.id, operator: operator ?? '知客' });
          if (p.status !== 'waitlisted') await promoteFromWaitlist(client, req.params.id, operator);
        } else {
          if (!['registered', 'proposed'].includes(p.status)) {
            skipped.push({ participant_id: pid, reason: `状态${p.status}不可签到` });
            continue;
          }
          // 未显式指定迟到时，按今天晚于到寺日期判定
          let st: 'checked_in' | 'late' = 'checked_in';
          if (action === 'late') st = 'late';
          else {
            const today = (await client.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d as string;
            if (today > p.arrive_date) st = 'late';
          }
          await client.query(
            `UPDATE ceremony_participants SET status=$3::ceremony_participant_status,
               checkin_at=now(), checkin_type=$3::ceremony_participant_status WHERE id=$1 AND ceremony_id=$2`,
            [p.id, req.params.id, st],
          );
          await writeLog(client, req.params.id, st, { dharma_name: p.dharma_name },
            { participantId: p.id, operator: operator ?? '知客' });
        }
        done++;
      }
      await client.query('COMMIT');
      return { ok: true, processed: done, skipped };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 单人签到（便于表格行操作）
  app.post<{ Params: { id: string; pid: string; action: string } }>(
    '/:id/participants/:pid/checkin/:action(checkin|late|no_show)',
    async (req) => {
      const r = await app.inject({
        method: 'POST',
        url: `/api/ceremonies/${req.params.id}/checkins/bulk`,
        payload: { participant_ids: [req.params.pid], action: req.params.action },
      });
      if (r.statusCode >= 400) throw new ApiError(r.statusCode, r.json()?.message ?? '操作失败');
      const body = r.json() as { processed: number; skipped: { reason: string }[] };
      if (body.processed === 0) {
        throw new ApiError(409, body.skipped[0]?.reason ?? '该人员当前状态无法执行此操作');
      }
      return body;
    },
  );

  // 提前离寺：释放床位、置 early_left、自动递补
  app.post<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/early-leave', async (req) => {
    const { leave_date, operator } = req.body as { leave_date?: string; operator?: string };
    const d = isDate(leave_date) ? leave_date : undefined;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockCeremony(client, req.params.id, ['active']);
      const p = (await client.query(
        `SELECT * FROM ceremony_participants WHERE id=$1 AND ceremony_id=$2
          AND status = ANY(ARRAY['checked_in','late','registered','proposed']
                          ::ceremony_participant_status[]) FOR UPDATE`,
        [req.params.pid, req.params.id],
      )).rows[0];
      if (!p) throw new ApiError(404, '可办理提前离寺的人员不存在');
      const today = d ?? (await client.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
      await client.query(
        `UPDATE ceremony_participants SET status='early_left', actual_leave_date=$2 WHERE id=$1`,
        [p.id, today],
      );
      await releaseParticipantBeds(client, p.id, 'early_leave');
      await writeLog(client, req.params.id, 'early_leave', {
        dharma_name: p.dharma_name, leave_date: today,
      }, { participantId: p.id, operator: operator ?? '知客' });
      const promoted = await promoteFromWaitlist(client, req.params.id, operator);
      await client.query('COMMIT');
      return {
        ok: true,
        promoted: promoted ? { id: promoted.id, dharma_name: promoted.dharma_name } : null,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // ==================== 统计 / 日志 ====================
  app.get<{ Params: { id: string } }>('/:id/stats', async (req) => {
    const client = await pool.connect();
    try {
      const c = await one<{ status: string; final_stats: unknown } | null>(
        `SELECT status, final_stats FROM ceremonies WHERE id=$1`, [req.params.id]);
      if (!c) throw new ApiError(404, '法会不存在');
      if (c.status === 'closed' && c.final_stats) return c.final_stats;
      return await computeStats(client, req.params.id);
    } finally {
      client.release();
    }
  });

  // 完整流水（导入/调床/递补/签到…）
  app.get<{ Params: { id: string } }>('/:id/logs', async (req) => {
    const { action, batch_no } = req.query as { action?: string; batch_no?: string };
    const conds = ['l.ceremony_id=$1'];
    const params: unknown[] = [req.params.id];
    if (action) { params.push(action); conds.push(`l.action=$${params.length}`); }
    if (batch_no) { params.push(Number(batch_no)); conds.push(`l.batch_no=$${params.length}`); }
    return many(`
      SELECT l.*, p.dharma_name
      FROM ceremony_event_log l
      LEFT JOIN ceremony_participants p ON p.id=l.participant_id
      WHERE ${conds.join(' AND ')}
      ORDER BY l.created_at DESC, l.id DESC
    `, params);
  });

  // 状态流转通用壳（保留给未来扩展）
  async function transition(
    ceremonyId: string, participantId: string,
    _from: ParticipantStatus[], _to: string,
    fn: (client: PoolClient, p: QueryResultRow) => Promise<void>,
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockCeremony(client, ceremonyId, ['preparing', 'active']);
      const p = (await client.query(
        `SELECT * FROM ceremony_participants WHERE id=$1 AND ceremony_id=$2 FOR UPDATE`,
        [participantId, ceremonyId],
      )).rows[0];
      if (!p) throw new ApiError(404, '法会人员不存在');
      if (!_from.includes(p.status)) throw new ApiError(409, `当前状态 ${p.status} 不允许此操作`);
      await fn(client, p);
      await client.query(
        `UPDATE ceremony_participants SET status=$3::ceremony_participant_status WHERE id=$1`,
        [participantId, ceremonyId, _to],
      );
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
};

export default routes;
