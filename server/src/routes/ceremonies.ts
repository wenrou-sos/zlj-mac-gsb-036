import type { FastifyPluginAsync } from 'fastify';
import type { PoolClient } from 'pg';
import { pool, many, one, ApiError, pgConflict } from '../db.js';

// 占用法会接待名额的人员状态
const CAPACITY_STATUSES = ['registered', 'bed_offered', 'confirmed', 'checked_in'];
// 仍有效（未到终态）的状态
const ACTIVE_STATUSES = ['registered', 'waitlisted', 'bed_offered', 'confirmed', 'checked_in'];
// 可签到状态
const CHECKINABLE = ['registered', 'bed_offered', 'confirmed'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type PgClient = PoolClient;

interface ImportRow {
  dharma_name?: string;
  home_monastery?: string | null;
  ordination_no?: string | null;
  contact?: string | null;
  special_need?: string | null;
  arrive_date?: string;
  leave_date?: string;
}

interface AdmitInput {
  name: string;
  home: string | null;
  ordNo: string | null;
  contact: string | null;
  need: string;
  arrive: string;
  leave: string;
}

interface AdmitResult {
  status: 'accepted' | 'waitlisted' | 'duplicate' | 'conflict' | 'invalid';
  message: string;
  participant_id?: string;
  waitlist_seq?: number;
  group_code?: string;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// 事务内查询助手：全局 one()/many() 走独立连接，读不到当前事务未提交的数据；
// 凡在 BEGIN..COMMIT 内的读写都必须使用传入的同一 client。
async function txOne<T = Record<string, unknown>>(pg: PgClient, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await pg.query(sql, params);
  return rows[0] as T;
}
async function txMany<T = Record<string, unknown>>(pg: PgClient, sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await pg.query(sql, params);
  return rows as T[];
}

function checkDate(v: unknown, label: string): string {
  if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    throw new ApiError(400, `${label}格式应为 YYYY-MM-DD`);
  }
  return v;
}

async function logEvent(
  pg: PgClient,
  ceremonyId: string,
  eventType: string,
  detail: Record<string, unknown>,
  operator: string,
  participantId?: string | null,
) {
  await pg.query(
    `INSERT INTO ceremony_event_log (ceremony_id, participant_id, event_type, detail, operator)
     VALUES ($1, $2, $3::ceremony_event_type, $4::jsonb, $5)`,
    [ceremonyId, participantId ?? null, eventType, JSON.stringify(detail), operator],
  );
}

async function getCeremony(pg: PgClient, id: string, forUpdate = false) {
  const { rows } = await pg.query(
    `SELECT * FROM dharma_ceremonies WHERE id=$1${forUpdate ? ' FOR UPDATE' : ''}`,
    [id],
  );
  if (rows.length === 0) throw new ApiError(404, '法会不存在');
  return rows[0] as {
    id: string; name: string; start_date: string; end_date: string;
    capacity: number; status: 'preparing' | 'ongoing' | 'closed';
  };
}

// 按到离寺时间 + 特殊需求重排分组号（G01…）
async function recomputeGroups(pg: PgClient, ceremonyId: string) {
  await pg.query(
    `
    WITH grp AS (
      SELECT arrive_date, leave_date, special_need,
             dense_rank() OVER (ORDER BY arrive_date, leave_date, special_need) AS seq
      FROM (
        SELECT DISTINCT arrive_date, leave_date, special_need
        FROM ceremony_participants
        WHERE ceremony_id=$1 AND status<>'cancelled'
      ) d
    )
    UPDATE ceremony_participants p SET group_code = 'G' || lpad(grp.seq::text, 2, '0')
    FROM grp
    WHERE p.ceremony_id=$1 AND p.status<>'cancelled'
      AND p.arrive_date=grp.arrive_date AND p.leave_date=grp.leave_date
      AND coalesce(p.special_need,'')=grp.special_need`,
    [ceremonyId],
  );
}

// 在区间内寻找可用临时床位：
//   1) beds.monk_id 为空（现有常住/挂单未入住，由事务内 FOR UPDATE 复核防并发抢占）；
//   2) 无 held/confirmed 的 ceremony_bed_stays 区间重叠（GiST 排他约束为最终防线）。
async function findAvailableBed(
  pg: PgClient,
  start: string,
  end: string,
  preferLower: boolean,
) {
  const { rows } = await pg.query(
    `
    SELECT b.id, b.bed_no, r.id AS room_id, r.room_no
    FROM beds b
    JOIN rooms r ON r.id = b.room_id
    WHERE b.monk_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ceremony_bed_stays s
        WHERE s.bed_id = b.id AND s.status <> 'released'
          AND daterange(s.stay_start, s.stay_end, '[]') && daterange($1, $2, '[]')
      )
    ORDER BY ${preferLower ? "CASE WHEN b.bed_no = '1' THEN 0 ELSE 1 END, " : ''}
             r.room_no, b.bed_no
    LIMIT 1
    FOR UPDATE OF b SKIP LOCKED`,
    [start, end],
  );
  return rows[0] as { id: string; bed_no: string; room_id: string; room_no: string } | undefined;
}

// 候补递补：队首若有可用床位且名额未满，则 held 预留并置 bed_offered，等待知客确认。
// 必须在持有法会行锁的事务内调用；名额/床位任一不满足则跳过（留待下次释放）。
async function promoteWaitlist(
  pg: PgClient,
  ceremonyId: string,
  operator: string,
  excludeId?: string,
) {
  const { rows: waitRows } = await pg.query(
    `SELECT p.* FROM ceremony_participants p
     WHERE p.ceremony_id=$1 AND p.status='waitlisted'
       AND ($2::uuid IS NULL OR p.id <> $2)
     ORDER BY p.waitlist_seq, p.created_at
     LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [ceremonyId, excludeId ?? null],
  );
  if (waitRows.length === 0) return null;
  const p = waitRows[0];
  const start = p.arrive_date < today() ? today() : p.arrive_date;
  const cap = await txOne<{ capacity: number }>(
    pg,
    `SELECT capacity FROM dharma_ceremonies WHERE id=$1`,
    [ceremonyId],
  );
  // 名额预检（当天起）：满员则本次不递补。coalesce 保证 HAVING 无行时返回 0
  const full = await txOne<{ n: number }>(
    pg,
    `SELECT coalesce((
       SELECT count(*)::int
       FROM generate_series(GREATEST(CURRENT_DATE, $2::date), $3::date, INTERVAL '1 day') d(d)
       JOIN ceremony_participants q
         ON q.ceremony_id=$1 AND q.status = ANY($4)
        AND d.d::date BETWEEN q.arrive_date AND q.leave_date
       GROUP BY d.d HAVING count(*) >= $5
       LIMIT 1), 0) AS n`,
    [ceremonyId, start, p.leave_date, CAPACITY_STATUSES, cap.capacity],
  );
  if (full.n > 0) return null;

  const preferLower = /下铺|病弱|行动不便/.test(p.special_need ?? '');
  const bed = await findAvailableBed(pg, start, p.leave_date, preferLower);
  if (!bed) return null;

  await pg.query(
    `INSERT INTO ceremony_bed_stays
       (ceremony_id, participant_id, bed_id, stay_start, stay_end, status, allocated_by)
     VALUES ($1,$2,$3,$4,$5,'held',$6)`,
    [ceremonyId, p.id, bed.id, start, p.leave_date, operator],
  );
  await pg.query(`UPDATE ceremony_participants SET status='bed_offered' WHERE id=$1`, [p.id]);
  await logEvent(
    pg,
    ceremonyId,
    'waitlist_promote',
    { waitlist_seq: p.waitlist_seq, room_no: bed.room_no, bed_no: bed.bed_no, stay_start: start },
    operator,
    p.id,
  );
  return { participant_id: p.id, dharma_name: p.dharma_name, ...bed };
}

async function runPromotions(
  pg: PgClient,
  ceremonyId: string,
  operator: string,
  maxN = 200,
  excludeId?: string,
) {
  const promoted: unknown[] = [];
  for (let i = 0; i < maxN; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await promoteWaitlist(pg, ceremonyId, operator, excludeId);
    if (!r) break;
    promoted.push(r);
  }
  return promoted;
}

// 释放一条床位占用并留痕；调用方负责随后 runPromotions
async function releaseStay(
  pg: PgClient,
  ceremonyId: string,
  stayId: string,
  endDate: string,
  reason: string,
  operator: string,
) {
  const { rows } = await pg.query(
    `
    UPDATE ceremony_bed_stays
    SET status='released',
        actual_end=GREATEST(stay_start - 1, LEAST(stay_end, $2::date - 1)),
        released_at=now(), release_reason=$3
    WHERE id=$1 AND status<>'released'
    RETURNING id, participant_id, bed_id, stay_start, stay_end`,
    [stayId, endDate, reason],
  );
  if (rows[0]) {
    await logEvent(pg, ceremonyId, 'release', { stay_id: stayId, reason, end_date: endDate }, operator, rows[0].participant_id);
  }
  return rows[0] as { id: string; participant_id: string; bed_id: string } | undefined;
}

// 单行准入校验 + 落库（导入与手工新增共用）
// 重复 / 撞期 / 容量满（自动候补）逐行判定。
async function admitRow(
  pg: PgClient,
  ceremony: { id: string; start_date: string; end_date: string; capacity: number },
  raw: ImportRow,
  ctx: { seenOrd: Set<string>; seenNameDate: Set<string>; nextWaitSeq: number },
  operator: string,
): Promise<AdmitResult> {
  const name = raw.dharma_name?.trim();
  if (!name) return { status: 'invalid', message: '法名不能为空' };
  const arrive = raw.arrive_date?.trim();
  const leave = raw.leave_date?.trim();
  if (!arrive || !leave) return { status: 'invalid', message: '到寺/离寺日期不能为空' };
  if (!DATE_RE.test(arrive) || !DATE_RE.test(leave) || Number.isNaN(Date.parse(arrive)) || Number.isNaN(Date.parse(leave))) {
    return { status: 'invalid', message: '日期格式应为 YYYY-MM-DD' };
  }
  if (leave < arrive) return { status: 'invalid', message: '离寺日期早于到寺日期' };
  if (arrive < ceremony.start_date || leave > ceremony.end_date) {
    return { status: 'invalid', message: `到离寺日期须在法会期间（${ceremony.start_date} ~ ${ceremony.end_date}）` };
  }
  const ordNo = raw.ordination_no?.trim() || null;
  const need = raw.special_need?.trim() || '';
  const nameDateKey = `${name}|${arrive}`;

  // —— 本批次内重复 ——
  if (ordNo && ctx.seenOrd.has(ordNo)) {
    return { status: 'duplicate', message: `本表格内戒牒编号 ${ordNo} 重复` };
  }
  if (!ordNo && ctx.seenNameDate.has(nameDateKey)) {
    return { status: 'duplicate', message: '本表格内同名且同到寺日期人员重复（无戒牒号无法区分）' };
  }

  // —— 库内重复：同法会未取消者（有戒牒号按戒牒号，无戒牒号按同名同到寺日兜底） ——
  if (ordNo) {
    const dup = await txOne<{ n: number }>(
      pg,
      `SELECT count(*)::int AS n FROM ceremony_participants
       WHERE ceremony_id=$1 AND status<>'cancelled' AND ordination_no=$2`,
      [ceremony.id, ordNo],
    );
    if (dup.n > 0) {
      return { status: 'duplicate', message: `戒牒编号 ${ordNo} 已在本法会登记` };
    }
  } else {
    const dupName = await txOne<{ n: number }>(
      pg,
      `SELECT count(*)::int AS n FROM ceremony_participants
       WHERE ceremony_id=$1 AND status<>'cancelled'
         AND dharma_name=$2 AND arrive_date=$3`,
      [ceremony.id, name, arrive],
    );
    if (dupName.n > 0) {
      return { status: 'duplicate', message: `${name}（${arrive} 到寺）已登记，建议补充戒牒编号后再导入` };
    }
  }

  // —— 撞期一：该僧人现有在寺挂单（guadan active）日期重叠 ——
  if (ordNo) {
    const g = await txOne<{ n: number }>(
      pg,
      `SELECT count(*)::int AS n
       FROM guadan g JOIN monks m ON m.id=g.monk_id
       WHERE g.status='active' AND m.ordination_no=$1
         AND daterange(g.arrive_date, (g.arrive_date + g.expected_days * INTERVAL '1 day')::date - 1, '[]')
             && daterange($2,$3,'[]')`,
      [ordNo, arrive, leave],
    );
    if (g.n > 0) {
      return { status: 'conflict', message: `戒牒编号 ${ordNo} 现有在寺挂单，与法会到离寺日期撞期` };
    }
    // —— 撞期二：其他法会名额占用期间重叠 ——
    const c2 = await txOne<{ names: string | null }>(
      pg,
      `SELECT string_agg(DISTINCT dc.name, '、') AS names
       FROM ceremony_participants p
       JOIN dharma_ceremonies dc ON dc.id=p.ceremony_id
       WHERE p.ordination_no=$1 AND p.ceremony_id<>$2
         AND p.status = ANY($3)
         AND daterange(p.arrive_date, p.leave_date, '[]') && daterange($4,$5,'[]')`,
      [ordNo, ceremony.id, CAPACITY_STATUSES, arrive, leave],
    );
    if (c2.names) {
      return { status: 'conflict', message: `与其他法会「${c2.names}」接待时间撞期` };
    }
  }

  // —— 容量预检：区间内任一日（当天起算，过去日期名额已自然释放）已达上限则自动候补 ——
  const full = await txOne<{ d: string; n: number } | null>(
    pg,
    `
    SELECT d.d::date, count(p.*)::int AS n
    FROM generate_series(GREATEST(CURRENT_DATE, $2::date), $3::date, INTERVAL '1 day') d(d)
    JOIN ceremony_participants p
      ON p.ceremony_id=$1 AND p.status = ANY($4)
     AND d.d::date BETWEEN p.arrive_date AND p.leave_date
    GROUP BY d.d
    HAVING count(p.*) >= $5
    ORDER BY d.d
    LIMIT 1`,
    [ceremony.id, arrive, leave, CAPACITY_STATUSES, ceremony.capacity],
  );

  let status: 'registered' | 'waitlisted' = 'registered';
  let waitSeq: number | null = null;
  let message = '已登记';
  if (full) {
    status = 'waitlisted';
    waitSeq = ctx.nextWaitSeq;
    ctx.nextWaitSeq += 1;
    message = `${full.d} 接待已满（上限 ${ceremony.capacity} 人），自动进入候补第 ${waitSeq} 位`;
  }
  if (ordNo) ctx.seenOrd.add(ordNo);
  ctx.seenNameDate.add(nameDateKey);

  const { rows } = await pg.query(
    `INSERT INTO ceremony_participants
       (ceremony_id, dharma_name, home_monastery, ordination_no, contact, special_need,
        arrive_date, leave_date, status, waitlist_seq, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, group_code`,
    [ceremony.id, name, raw.home_monastery?.trim() || null, ordNo, raw.contact?.trim() || null,
      need, arrive, leave, status, waitSeq, operator],
  );
  await logEvent(
    pg,
    ceremony.id,
    'import',
    { dharma_name: name, ordination_no: ordNo, arrive, leave, result: status, waitlist_seq: waitSeq },
    operator,
    rows[0].id,
  );
  return {
    status: status === 'waitlisted' ? 'waitlisted' : 'accepted',
    message,
    participant_id: rows[0].id,
    waitlist_seq: waitSeq ?? undefined,
  };
}

// 容量约束兜底：预检之后因并发等原因触发触发器时，直接落候补行
async function admitAsWaitlisted(
  pg: PgClient,
  ceremony: { id: string },
  raw: ImportRow,
  ctx: { seenOrd: Set<string>; seenNameDate: Set<string>; nextWaitSeq: number },
  operator: string,
): Promise<AdmitResult> {
  const name = raw.dharma_name?.trim();
  const arrive = raw.arrive_date?.trim() as string;
  const leave = raw.leave_date?.trim() as string;
  const ordNo = raw.ordination_no?.trim() || null;
  const waitSeq = ctx.nextWaitSeq;
  ctx.nextWaitSeq += 1;
  if (ordNo) ctx.seenOrd.add(ordNo);
  ctx.seenNameDate.add(`${name}|${arrive}`);
  const { rows } = await pg.query(
    `INSERT INTO ceremony_participants
       (ceremony_id, dharma_name, home_monastery, ordination_no, contact, special_need,
        arrive_date, leave_date, status, waitlist_seq, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'waitlisted',$9,$10)
     RETURNING id`,
    [ceremony.id, name ?? '', raw.home_monastery?.trim() || null, ordNo,
      raw.contact?.trim() || null, raw.special_need?.trim() || '',
      arrive, leave, waitSeq, operator],
  );
  return {
    status: 'waitlisted',
    message: `接待已满，自动进入候补第 ${waitSeq} 位（容量约束兜底）`,
    participant_id: rows[0].id,
    waitlist_seq: waitSeq,
  };
}

// ===================================================================
const routes: FastifyPluginAsync = async (app) => {
  // ---------------- 法会列表 ----------------
  app.get('/', async (req) => {
    const { status } = req.query as { status?: string };
    const params: unknown[] = [ACTIVE_STATUSES];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE c.status = $2::ceremony_status`;
    }
    return many(
      `
      SELECT c.*,
        (SELECT count(*) FROM ceremony_participants p
          WHERE p.ceremony_id=c.id AND p.status = ANY($1))::int AS active_count,
        (SELECT count(*) FROM ceremony_participants p
          WHERE p.ceremony_id=c.id AND p.status='waitlisted')::int AS waitlist_count,
        (SELECT count(*) FROM ceremony_participants p
          WHERE p.ceremony_id=c.id AND p.status='checked_in')::int AS checked_in_count
      FROM dharma_ceremonies c
      ${where}
      ORDER BY c.start_date DESC, c.created_at DESC`,
      params,
    );
  });

  // ---------------- 创建法会 ----------------
  app.post('/', async (req, reply) => {
    const b = req.body as {
      name?: string; start_date?: string; end_date?: string;
      capacity?: number; note?: string | null; created_by?: string;
    };
    if (!b.name?.trim()) throw new ApiError(400, '法会名称不能为空');
    const startDate = checkDate(b.start_date, '开始日期');
    const endDate = checkDate(b.end_date, '结束日期');
    if (endDate < startDate) throw new ApiError(400, '结束日期不能早于开始日期');
    if (!b.capacity || b.capacity <= 0) throw new ApiError(400, '接待上限必须为正整数');
    const operator = b.created_by ?? '知客';

    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      const { rows } = await pg.query(
        `INSERT INTO dharma_ceremonies (name, start_date, end_date, capacity, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [b.name.trim(), startDate, endDate, b.capacity, b.note ?? null, operator],
      );
      await logEvent(pg, rows[0].id, 'create', { name: b.name.trim(), start_date: startDate, end_date: endDate, capacity: b.capacity }, operator);
      await pg.query('COMMIT');
      return reply.code(201).send(rows[0]);
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 法会详情（含分项计数） ----------------
  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const c = await one(`SELECT * FROM dharma_ceremonies WHERE id=$1`, [req.params.id]);
    if (!c) throw new ApiError(404, '法会不存在');
    const stats = await one(
      `SELECT
         count(*) FILTER (WHERE status = ANY($2))::int AS active_count,
         count(*) FILTER (WHERE status='registered')::int AS registered_count,
         count(*) FILTER (WHERE status='waitlisted')::int AS waitlist_count,
         count(*) FILTER (WHERE status='bed_offered')::int AS offered_count,
         count(*) FILTER (WHERE status='confirmed')::int AS confirmed_count,
         count(*) FILTER (WHERE status='checked_in')::int AS checked_in_count,
         count(*) FILTER (WHERE status='early_left')::int AS early_left_count,
         count(*) FILTER (WHERE status='no_show')::int AS no_show_count,
         count(*) FILTER (WHERE status='cancelled')::int AS cancelled_count,
         (SELECT count(*) FROM ceremony_bed_stays s
           WHERE s.ceremony_id=$1 AND s.status<>'released')::int AS bed_held
       FROM ceremony_participants WHERE ceremony_id=$1`,
      [req.params.id, ACTIVE_STATUSES],
    );
    return { ...c, ...stats };
  });

  // ---------------- 调整法会（仅备会期；上限不得低于已排峰值） ----------------
  app.put<{ Params: { id: string } }>('/:id', async (req) => {
    const b = req.body as {
      name?: string; start_date?: string; end_date?: string;
      capacity?: number; note?: string | null;
    };
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      const c = await getCeremony(pg, req.params.id, true);
      if (c.status !== 'preparing') throw new ApiError(409, '法会已开始，日期与接待上限不可修改');
      const startDate = b.start_date ? checkDate(b.start_date, '开始日期') : c.start_date;
      const endDate = b.end_date ? checkDate(b.end_date, '结束日期') : c.end_date;
      if (endDate < startDate) throw new ApiError(400, '结束日期不能早于开始日期');
      const capacity = b.capacity ?? c.capacity;
      if (capacity <= 0) throw new ApiError(400, '接待上限必须为正整数');
      if (capacity < c.capacity) {
        const peak = await txOne<{ n: number }>(
          pg,
          `SELECT coalesce(max(n),0)::int AS n FROM (
             SELECT d.d::date, count(*)::int AS n
             FROM generate_series($2::date, $3::date, INTERVAL '1 day') d(d)
             JOIN ceremony_participants p
               ON p.ceremony_id=$1 AND p.status = ANY($4)
              AND d.d::date BETWEEN p.arrive_date AND p.leave_date
             GROUP BY d.d) t`,
          [req.params.id, startDate, endDate, CAPACITY_STATUSES],
        );
        if (peak.n > capacity) throw new ApiError(409, `接待上限不得低于已排人数峰值 ${peak.n} 人`);
      }
      const { rows } = await pg.query(
        `UPDATE dharma_ceremonies
         SET name=COALESCE($2,name), start_date=$3, end_date=$4, capacity=$5, note=COALESCE($6,note)
         WHERE id=$1 RETURNING *`,
        [req.params.id, b.name?.trim() ?? null, startDate, endDate, capacity, b.note ?? null],
      );
      await pg.query('COMMIT');
      return rows[0];
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 开始 / 圆满 ----------------
  app.post<{ Params: { id: string; action: string } }>('/:id/action/:action', async (req) => {
    const { id, action } = req.params;
    const operator = (req.body as { operator?: string } | undefined)?.operator ?? '知客';
    if (action !== 'start' && action !== 'close') throw new ApiError(400, '未知操作');
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      const c = await getCeremony(pg, id, true);
      if (action === 'start') {
        if (c.status !== 'preparing') throw new ApiError(409, '仅备会中的法会可以开始');
        await pg.query(`UPDATE dharma_ceremonies SET status='ongoing' WHERE id=$1`, [id]);
      } else {
        if (c.status === 'closed') throw new ApiError(409, '法会已圆满');
        await pg.query(`UPDATE dharma_ceremonies SET status='closed', closed_at=now() WHERE id=$1`, [id]);
        await logEvent(pg, id, 'close', {}, operator);
      }
      await pg.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 批量表格导入（逐行反馈，行级 SAVEPOINT） ----------------
  app.post<{ Params: { id: string } }>('/:id/import', async (req, reply) => {
    const { id } = req.params;
    const body = req.body as { rows?: ImportRow[]; file_name?: string; operator?: string };
    if (!Array.isArray(body.rows) || body.rows.length === 0) throw new ApiError(400, '导入数据为空');
    if (body.rows.length > 1000) throw new ApiError(400, '单次导入不得超过 1000 行');
    const operator = body.operator ?? '知客';

    const rowResults: Record<string, unknown>[] = [];
    const counters = {
      accepted_count: 0, waitlisted_count: 0, duplicate_count: 0,
      conflict_count: 0, capacity_count: 0, invalid_count: 0,
    };
    const ctx = { seenOrd: new Set<string>(), seenNameDate: new Set<string>(), nextWaitSeq: 1 };

    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      const ceremony = await getCeremony(pg, id, true); // 法会行锁：串行化名额/候补竞争
      if (ceremony.status === 'closed') throw new ApiError(409, '法会已圆满，不可再导入');

      const maxSeq = await txOne<{ n: number }>(
        pg,
        `SELECT coalesce(max(waitlist_seq),0)::int AS n FROM ceremony_participants WHERE ceremony_id=$1`,
        [id],
      );
      ctx.nextWaitSeq = maxSeq.n + 1;

      for (let i = 0; i < body.rows.length; i += 1) {
        const raw = body.rows[i];
        const rowNo = i + 1;
        // eslint-disable-next-line no-await-in-loop
        await pg.query(`SAVEPOINT sp_${rowNo}`);
        let res: AdmitResult;
        try {
          // eslint-disable-next-line no-await-in-loop
          res = await admitRow(pg, ceremony, raw, ctx, operator);
        } catch (e) {
          // eslint-disable-next-line no-await-in-loop
          await pg.query(`ROLLBACK TO SAVEPOINT sp_${rowNo}`);
          const code = (e as { code?: string; constraint?: string }).code;
          const constraint = (e as { constraint?: string }).constraint;
          if (constraint === 'ceremony_capacity' || code === '23514') {
            // 容量约束兜底：法会行锁已串行化，正常走预检候补；此处再补落候补行
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            res = await admitAsWaitlisted(pg, ceremony, raw, ctx, operator);
          } else if (code === '23505') {
            res = { status: 'duplicate', message: '与已有登记重复（唯一约束兜底）' };
          } else {
            res = { status: 'invalid', message: (e as Error).message };
          }
        }
        // eslint-disable-next-line no-await-in-loop
        await pg.query(`RELEASE SAVEPOINT sp_${rowNo}`);

        if (res!.status === 'waitlisted') {
          counters.waitlisted_count += 1;
          counters.capacity_count += 1;
        } else if (res!.status === 'accepted') {
          counters.accepted_count += 1;
        } else {
          counters[`${res!.status}_count` as 'duplicate_count' | 'conflict_count' | 'invalid_count'] += 1;
        }
        rowResults.push({
          row_no: rowNo,
          dharma_name: raw.dharma_name?.trim() ?? '',
          ordination_no: raw.ordination_no?.trim() ?? '',
          arrive_date: raw.arrive_date?.trim() ?? '',
          leave_date: raw.leave_date?.trim() ?? '',
          status: res!.status,
          message: res!.message,
          participant_id: res!.participant_id ?? null,
          waitlist_seq: res!.waitlist_seq ?? null,
        });
      }

      await recomputeGroups(pg, id);

      const { rows: batchRows } = await pg.query(
        `INSERT INTO ceremony_import_batches
           (ceremony_id, file_name, total_rows, accepted_count, waitlisted_count,
            duplicate_count, conflict_count, capacity_count, invalid_count, row_results, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
         RETURNING *`,
        [id, body.file_name ?? null, body.rows.length,
          counters.accepted_count, counters.waitlisted_count,
          counters.duplicate_count, counters.conflict_count, counters.capacity_count,
          counters.invalid_count, JSON.stringify(rowResults), operator],
      );

      await pg.query('COMMIT');
      return reply.code(201).send(batchRows[0]);
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 手工新增单人 ----------------
  app.post<{ Params: { id: string } }>('/:id/participants', async (req, reply) => {
    const body = req.body as ImportRow & { operator?: string };
    const operator = body.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      const ceremony = await getCeremony(pg, req.params.id, true);
      if (ceremony.status === 'closed') throw new ApiError(409, '法会已圆满，不可再登记');
      const maxSeq = await txOne<{ n: number }>(
        pg,
        `SELECT coalesce(max(waitlist_seq),0)::int AS n FROM ceremony_participants WHERE ceremony_id=$1`,
        [req.params.id],
      );
      const res = await admitRow(
        pg, ceremony, body,
        { seenOrd: new Set(), seenNameDate: new Set(), nextWaitSeq: maxSeq.n + 1 },
        operator,
      );
      if (res.status !== 'accepted' && res.status !== 'waitlisted') {
        throw new ApiError(res.status === 'invalid' ? 400 : 409, res.message);
      }
      await recomputeGroups(pg, req.params.id);
      await pg.query('COMMIT');
      return reply.code(201).send(res);
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 人员名册（含床位/签到） ----------------
  app.get<{ Params: { id: string } }>('/:id/participants', async (req) => {
    const { status, group } = req.query as { status?: string; group?: string };
    const conds: string[] = ['p.ceremony_id=$1'];
    const params: unknown[] = [req.params.id];
    if (status) {
      params.push(status);
      conds.push(`p.status=$${params.length}::participant_status`);
    }
    if (group) {
      params.push(group);
      conds.push(`p.group_code=$${params.length}`);
    }
    return many(
      `
      SELECT p.*, r.room_no, b.bed_no, s.status AS stay_status, s.id AS stay_id,
             c.checkin_date, c.checkin_kind, c.checkout_date, c.checkout_early
      FROM ceremony_participants p
      LEFT JOIN ceremony_bed_stays s ON s.participant_id=p.id AND s.status<>'released'
      LEFT JOIN beds b ON b.id=s.bed_id
      LEFT JOIN rooms r ON r.id=b.room_id
      LEFT JOIN ceremony_checkins c ON c.participant_id=p.id
      WHERE ${conds.join(' AND ')}
      ORDER BY
        array_position(ARRAY['checked_in','bed_offered','confirmed','registered','waitlisted',
                             'early_left','no_show','checked_out','cancelled']::participant_status[], p.status),
        p.group_code NULLS LAST, p.waitlist_seq NULLS FIRST, p.arrive_date, p.dharma_name`,
      params,
    );
  });

  // ---------------- 候补队列 ----------------
  app.get<{ Params: { id: string } }>('/:id/waitlist', async (req) => {
    return many(
      `SELECT p.* FROM ceremony_participants p
       WHERE p.ceremony_id=$1 AND p.status='waitlisted'
       ORDER BY p.waitlist_seq, p.created_at`,
      [req.params.id],
    );
  });

  // ---------------- 区间可用临时床位 ----------------
  app.get<{ Params: { id: string } }>('/:id/available-beds', async (req) => {
    const { start, end } = req.query as { start?: string; end?: string };
    if (!start || !end) throw new ApiError(400, '请提供起止日期');
    return many(
      `
      SELECT b.id, b.bed_no, r.id AS room_id, r.room_no
      FROM beds b JOIN rooms r ON r.id=b.room_id
      WHERE b.monk_id IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ceremony_bed_stays s
          WHERE s.bed_id=b.id AND s.status<>'released'
            AND daterange(s.stay_start, s.stay_end,'[]') && daterange($1,$2,'[]')
        )
      ORDER BY r.room_no, b.bed_no`,
      [start, end],
    );
  });

  // ---------------- 自动分床（registered 人员，按分组/到离/特殊需求） ----------------
  app.post<{ Params: { id: string } }>('/:id/allocate-beds', async (req) => {
    const operator = (req.body as { operator?: string } | undefined)?.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, req.params.id, true);
      const list = await txMany<{
        id: string; dharma_name: string; special_need: string;
        arrive_date: string; leave_date: string; group_code: string | null;
      }>(
        pg,
        `SELECT id, dharma_name, special_need, arrive_date, leave_date, group_code
         FROM ceremony_participants
         WHERE ceremony_id=$1 AND status='registered'
           AND NOT EXISTS (SELECT 1 FROM ceremony_bed_stays s
                            WHERE s.participant_id=ceremony_participants.id AND s.status<>'released')
         ORDER BY group_code NULLS LAST, arrive_date,
                  CASE WHEN special_need<>'' THEN 0 ELSE 1 END, dharma_name`,
        [req.params.id],
      );
      const allocated: unknown[] = [];
      for (const p of list) {
        // eslint-disable-next-line no-await-in-loop
        const bed = await findAvailableBed(pg, p.arrive_date, p.leave_date, /下铺|病弱|行动不便/.test(p.special_need));
        if (!bed) continue;
        // eslint-disable-next-line no-await-in-loop
        await pg.query(
          `INSERT INTO ceremony_bed_stays
             (ceremony_id, participant_id, bed_id, stay_start, stay_end, status, allocated_by)
           VALUES ($1,$2,$3,$4,$5,'confirmed',$6)`,
          [req.params.id, p.id, bed.id, p.arrive_date, p.leave_date, operator],
        );
        // eslint-disable-next-line no-await-in-loop
        await pg.query(`UPDATE ceremony_participants SET status='confirmed' WHERE id=$1`, [p.id]);
        // eslint-disable-next-line no-await-in-loop
        await logEvent(pg, req.params.id, 'allocate', { room_no: bed.room_no, bed_no: bed.bed_no }, operator, p.id);
        allocated.push({ participant_id: p.id, dharma_name: p.dharma_name, ...bed });
      }
      await pg.query('COMMIT');
      return { allocated, total: list.length, bedless: list.length - allocated.length };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // 取人员的有效床位占用
  async function getActiveStay(pg: PgClient, participantId: string) {
    const { rows } = await pg.query(
      `SELECT s.* FROM ceremony_bed_stays s
       WHERE s.participant_id=$1 AND s.status<>'released'
       ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE`,
      [participantId],
    );
    return rows[0] as {
      id: string; bed_id: string; stay_start: string; stay_end: string;
      status: 'held' | 'confirmed';
    } | undefined;
  }

  // ---------------- 指定 / 调换床位 ----------------
  app.put<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/bed', async (req) => {
    const { id, pid } = req.params;
    const b = req.body as { bed_id?: string; stay_start?: string; stay_end?: string; operator?: string };
    if (!b.bed_id) throw new ApiError(400, '请选择床位');
    const operator = b.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const { rows: pRows } = await pg.query(
        `SELECT * FROM ceremony_participants WHERE id=$1 AND ceremony_id=$2 FOR UPDATE`,
        [pid, id],
      );
      if (pRows.length === 0) throw new ApiError(404, '临时人员不存在');
      const p = pRows[0];
      if (['no_show', 'checked_out', 'cancelled', 'early_left'].includes(p.status)) {
        throw new ApiError(409, '该人员已离寺/未到/取消，不能安排床位');
      }
      const start = b.stay_start ? checkDate(b.stay_start, '入住起') : p.arrive_date;
      const end = b.stay_end ? checkDate(b.stay_end, '入住止') : p.leave_date;
      if (end < start) throw new ApiError(400, '入住区间不合法');

      // 现有入住复核：锁住床位行，串行化并发抢占
      const { rows: bedRows } = await pg.query(
        'SELECT id, monk_id FROM beds WHERE id=$1 FOR UPDATE',
        [b.bed_id],
      );
      if (bedRows.length === 0) throw new ApiError(400, '床位不存在');
      if (bedRows[0].monk_id && bedRows[0].monk_id !== p.id) {
        throw new ApiError(409, '该床位现有常住/挂单僧人入住，不可安排给法会临时人员');
      }
      // 日期重叠复核（排他约束兜底）
      const overlap = await txOne<{ n: number }>(
        pg,
        `SELECT count(*)::int AS n FROM ceremony_bed_stays s
         WHERE s.bed_id=$1 AND s.status<>'released' AND s.participant_id<>$2
           AND daterange(s.stay_start, s.stay_end,'[]') && daterange($3,$4,'[]')`,
        [b.bed_id, pid, start, end],
      );
      if (overlap.n > 0) throw new ApiError(409, '该床位所选区间与其他临时人员占用日期重叠');

      const oldStay = await getActiveStay(pg, pid);
      let fromBed: { room_no: string; bed_no: string } | null = null;
      if (oldStay && oldStay.bed_id !== b.bed_id) {
        const fr = await txOne<{ room_no: string; bed_no: string }>(
          pg,
          `SELECT r.room_no, b.bed_no FROM beds b JOIN rooms r ON r.id=b.room_id WHERE b.id=$1`,
          [oldStay.bed_id],
        );
        fromBed = fr;
        await pg.query(
          `UPDATE ceremony_bed_stays SET status='released', released_at=now(), release_reason='bed_change'
           WHERE id=$1`,
          [oldStay.id],
        );
      } else if (oldStay) {
        // 同床调整区间
        await pg.query(
          `UPDATE ceremony_bed_stays SET stay_start=$2, stay_end=$3 WHERE id=$1`,
          [oldStay.id, start, end],
        );
        await pg.query('COMMIT');
        return { ok: true, changed: false };
      }

      // waitlisted 手工指定床位 → bed_offered（held），仍需知客确认；其余 → confirmed
      const held = p.status === 'waitlisted';
      await pg.query(
        `INSERT INTO ceremony_bed_stays
           (ceremony_id, participant_id, bed_id, stay_start, stay_end, status, allocated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, pid, b.bed_id, start, end, held ? 'held' : 'confirmed', operator],
      );
      if (held) {
        await pg.query(`UPDATE ceremony_participants SET status='bed_offered' WHERE id=$1`, [pid]);
      } else if (p.status === 'registered' || p.status === 'bed_offered') {
        await pg.query(`UPDATE ceremony_participants SET status='confirmed' WHERE id=$1`, [pid]);
      }
      const toBed = await txOne<{ room_no: string; bed_no: string }>(
        pg,
        `SELECT r.room_no, b.bed_no FROM beds b JOIN rooms r ON r.id=b.room_id WHERE b.id=$1`,
        [b.bed_id],
      );
      await logEvent(
        pg, id, held ? 'waitlist_promote' : 'bed_change',
        { from: fromBed, to: toBed, stay_start: start, stay_end: end, manual: true },
        operator, pid,
      );
      await pg.query('COMMIT');
      return { ok: true, changed: true, held_for_confirm: held };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 知客确认递补床位 ----------------
  app.post<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/offer/confirm', async (req) => {
    const { id, pid } = req.params;
    const operator = (req.body as { operator?: string } | undefined)?.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const stay = await getActiveStay(pg, pid);
      if (!stay || stay.status !== 'held') throw new ApiError(409, '没有待确认的递补床位');
      await pg.query(`UPDATE ceremony_bed_stays SET status='confirmed' WHERE id=$1`, [stay.id]);
      await pg.query(`UPDATE ceremony_participants SET status='confirmed' WHERE id=$1`, [pid]);
      const bed = await txOne<{ room_no: string; bed_no: string }>(
        pg,
        `SELECT r.room_no, b.bed_no FROM beds b JOIN rooms r ON r.id=b.room_id WHERE b.id=$1`,
        [stay.bed_id],
      );
      await logEvent(pg, id, 'offer_confirm', bed, operator, pid);
      await pg.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 知客谢绝递补（回候补队尾，床位继续递补下一位） ----------------
  app.post<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/offer/reject', async (req) => {
    const { id, pid } = req.params;
    const operator = (req.body as { operator?: string; reason?: string } | undefined)?.operator ?? '知客';
    const reason = (req.body as { reason?: string } | undefined)?.reason;
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const stay = await getActiveStay(pg, pid);
      if (!stay || stay.status !== 'held') throw new ApiError(409, '没有待确认的递补床位');
      await pg.query(
        `UPDATE ceremony_bed_stays SET status='released', released_at=now(), release_reason='offer_rejected'
         WHERE id=$1`,
        [stay.id],
      );
      const nextSeq = await txOne<{ n: number }>(
        pg,
        `SELECT coalesce(max(waitlist_seq),0)::int + 1 AS n FROM ceremony_participants WHERE ceremony_id=$1`,
        [id],
      );
      await pg.query(
        `UPDATE ceremony_participants SET status='waitlisted', waitlist_seq=$2 WHERE id=$1`,
        [pid, nextSeq.n],
      );
      await logEvent(pg, id, 'offer_reject', { reason: reason ?? null }, operator, pid);
      // 谢绝者回队尾，本次递补跳过本人，把床位让给下一位候补
      const promoted = await runPromotions(pg, id, operator, 1, pid);
      await pg.query('COMMIT');
      return { ok: true, promoted_to: promoted[0] ?? null };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 手动释放床位（释放后自动递补） ----------------
  app.post<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/release-bed', async (req) => {
    const { id, pid } = req.params;
    const b = req.body as { reason?: string; date?: string; operator?: string };
    const operator = b.operator ?? '知客';
    const date = b.date ? checkDate(b.date, '日期') : today();
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const stay = await getActiveStay(pg, pid);
      if (!stay) throw new ApiError(404, '该人员没有在占用的床位');
      await releaseStay(pg, id, stay.id, date, b.reason ?? 'manual', operator);
      if (stay.status === 'held') {
        const nextSeq = await txOne<{ n: number }>(
          pg,
          `SELECT coalesce(max(waitlist_seq),0)::int + 1 AS n FROM ceremony_participants WHERE ceremony_id=$1`,
          [id],
        );
        await pg.query(
          `UPDATE ceremony_participants SET status='waitlisted', waitlist_seq=$2 WHERE id=$1`,
          [pid, nextSeq.n],
        );
      } else if ((await txOne<{ s: string }>(pg, 'SELECT status AS s FROM ceremony_participants WHERE id=$1', [pid])).s === 'confirmed') {
        await pg.query(`UPDATE ceremony_participants SET status='registered' WHERE id=$1`, [pid]);
      }
      const promoted = await runPromotions(pg, id, operator);
      await pg.query('COMMIT');
      return { ok: true, promoted };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 取消登记（未到前） ----------------
  app.post<{ Params: { id: string; pid: string } }>('/:id/participants/:pid/cancel', async (req) => {
    const { id, pid } = req.params;
    const operator = (req.body as { operator?: string } | undefined)?.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const { rows } = await pg.query(
        `SELECT status FROM ceremony_participants WHERE id=$1 AND ceremony_id=$2 FOR UPDATE`,
        [pid, id],
      );
      if (rows.length === 0) throw new ApiError(404, '临时人员不存在');
      if (rows[0].status === 'checked_in' || rows[0].status === 'early_left') {
        throw new ApiError(409, '已签到在寺者请走离寺流程');
      }
      const stay = await getActiveStay(pg, pid);
      if (stay) await releaseStay(pg, id, stay.id, today(), 'cancel', operator);
      await pg.query(`UPDATE ceremony_participants SET status='cancelled' WHERE id=$1`, [pid]);
      await logEvent(pg, id, 'cancel', {}, operator, pid);
      const promoted = await runPromotions(pg, id, operator);
      await pg.query('COMMIT');
      return { ok: true, promoted };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // 取一批有效人员，校验状态
  async function lockParticipants(pg: PgClient, ceremonyId: string, ids: string[]) {
    const { rows } = await pg.query(
      `SELECT * FROM ceremony_participants
       WHERE ceremony_id=$1 AND id = ANY($2)
       ORDER BY id FOR UPDATE`,
      [ceremonyId, ids],
    );
    return rows as {
      id: string; dharma_name: string; status: string;
      arrive_date: string; leave_date: string;
    }[];
  }

  // ---------------- 批量签到（自动判定如期/迟到；bed_offered 随到随确认） ----------------
  app.post<{ Params: { id: string } }>('/:id/checkin', async (req) => {
    const { id } = req.params;
    const b = req.body as { participant_ids?: string[]; date?: string; operator?: string; note?: string };
    if (!Array.isArray(b.participant_ids) || b.participant_ids.length === 0) throw new ApiError(400, '请选择签到人员');
    const date = b.date ? checkDate(b.date, '签到日期') : today();
    const operator = b.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const ps = await lockParticipants(pg, id, b.participant_ids);
      let onTime = 0;
      let late = 0;
      for (const p of ps) {
        if (!CHECKINABLE.includes(p.status)) {
          throw new ApiError(409, `${p.dharma_name}当前状态为「${p.status}」，不可签到`);
        }
        const kind = date <= p.arrive_date ? 'on_time' : 'late';
        if (kind === 'on_time') onTime += 1; else late += 1;
        // eslint-disable-next-line no-await-in-loop
        await pg.query(
          `INSERT INTO ceremony_checkins (ceremony_id, participant_id, checkin_date, checkin_kind, recorded_by, note)
           VALUES ($1,$2,$3,$4::checkin_kind,$5,$6)
           ON CONFLICT (participant_id)
           DO UPDATE SET checkin_date=EXCLUDED.checkin_date, checkin_kind=EXCLUDED.checkin_kind,
                         recorded_by=EXCLUDED.recorded_by, note=EXCLUDED.note`,
          [id, p.id, date, kind, operator, b.note ?? null],
        );
        // eslint-disable-next-line no-await-in-loop
        const stay = await getActiveStay(pg, p.id);
        if (stay?.status === 'held') {
          // eslint-disable-next-line no-await-in-loop
          await pg.query(`UPDATE ceremony_bed_stays SET status='confirmed' WHERE id=$1`, [stay.id]);
        }
        // eslint-disable-next-line no-await-in-loop
        await pg.query(`UPDATE ceremony_participants SET status='checked_in' WHERE id=$1`, [p.id]);
        // eslint-disable-next-line no-await-in-loop
        await logEvent(pg, id, 'checkin', { kind, date }, operator, p.id);
      }
      await pg.query('COMMIT');
      return { ok: true, total: ps.length, on_time: onTime, late };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 批量标记未到（释放床位并自动递补） ----------------
  app.post<{ Params: { id: string } }>('/:id/no-show', async (req) => {
    const { id } = req.params;
    const b = req.body as { participant_ids?: string[]; date?: string; operator?: string; note?: string };
    if (!Array.isArray(b.participant_ids) || b.participant_ids.length === 0) throw new ApiError(400, '请选择人员');
    const date = b.date ? checkDate(b.date, '日期') : today();
    const operator = b.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const ps = await lockParticipants(pg, id, b.participant_ids);
      for (const p of ps) {
        if (!['registered', 'bed_offered', 'confirmed', 'waitlisted'].includes(p.status)) {
          throw new ApiError(409, `${p.dharma_name}当前状态为「${p.status}」，不能标记未到`);
        }
        // eslint-disable-next-line no-await-in-loop
        const stay = await getActiveStay(pg, p.id);
        if (stay) // eslint-disable-next-line no-await-in-loop
          await releaseStay(pg, id, stay.id, date, 'no_show', operator);
        // eslint-disable-next-line no-await-in-loop
        await pg.query(
          `INSERT INTO ceremony_checkins (ceremony_id, participant_id, checkin_date, checkin_kind, recorded_by, note)
           VALUES ($1,$2,NULL,NULL,$3,$4)
           ON CONFLICT (participant_id) DO UPDATE SET checkin_date=NULL, checkin_kind=NULL, note=EXCLUDED.note`,
          [id, p.id, operator, b.note ?? '未到'],
        );
        // eslint-disable-next-line no-await-in-loop
        await pg.query(`UPDATE ceremony_participants SET status='no_show' WHERE id=$1`, [p.id]);
        // eslint-disable-next-line no-await-in-loop
        await logEvent(pg, id, 'no_show', { date }, operator, p.id);
      }
      const promoted = await runPromotions(pg, id, operator);
      await pg.query('COMMIT');
      return { ok: true, total: ps.length, promoted };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 批量提前离寺（释放床位并自动递补） ----------------
  app.post<{ Params: { id: string } }>('/:id/early-leave', async (req) => {
    const { id } = req.params;
    const b = req.body as { participant_ids?: string[]; date?: string; operator?: string; note?: string };
    if (!Array.isArray(b.participant_ids) || b.participant_ids.length === 0) throw new ApiError(400, '请选择人员');
    const date = b.date ? checkDate(b.date, '离寺日期') : today();
    const operator = b.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const ps = await lockParticipants(pg, id, b.participant_ids);
      for (const p of ps) {
        if (p.status !== 'checked_in') {
          throw new ApiError(409, `${p.dharma_name}尚未签到，不能登记提前离寺（当前：${p.status}）`);
        }
        if (date >= p.leave_date) throw new ApiError(409, `${p.dharma_name}离寺日期不早于预计离寺日，属正常离寺`);
        // eslint-disable-next-line no-await-in-loop
        const stay = await getActiveStay(pg, p.id);
        if (stay) // eslint-disable-next-line no-await-in-loop
          await releaseStay(pg, id, stay.id, date, 'early_leave', operator);
        // eslint-disable-next-line no-await-in-loop
        await pg.query(
          `INSERT INTO ceremony_checkins (ceremony_id, participant_id, checkout_date, checkout_early, recorded_by, note)
           VALUES ($1,$2,$3,true,$4,$5)
           ON CONFLICT (participant_id) DO UPDATE SET checkout_date=EXCLUDED.checkout_date,
             checkout_early=true, note=COALESCE(EXCLUDED.note, ceremony_checkins.note)`,
          [id, p.id, date, operator, b.note ?? null],
        );
        // eslint-disable-next-line no-await-in-loop
        await pg.query(`UPDATE ceremony_participants SET status='early_left' WHERE id=$1`, [p.id]);
        // eslint-disable-next-line no-await-in-loop
        await logEvent(pg, id, 'early_leave', { date }, operator, p.id);
      }
      const promoted = await runPromotions(pg, id, operator);
      await pg.query('COMMIT');
      return { ok: true, total: ps.length, promoted };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 批量正常离寺 ----------------
  app.post<{ Params: { id: string } }>('/:id/checkout', async (req) => {
    const { id } = req.params;
    const b = req.body as { participant_ids?: string[]; date?: string; operator?: string };
    if (!Array.isArray(b.participant_ids) || b.participant_ids.length === 0) throw new ApiError(400, '请选择人员');
    const date = b.date ? checkDate(b.date, '离寺日期') : today();
    const operator = b.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const ps = await lockParticipants(pg, id, b.participant_ids);
      for (const p of ps) {
        if (!['checked_in', 'early_left'].includes(p.status)) {
          throw new ApiError(409, `${p.dharma_name}当前状态为「${p.status}」，不能办理离寺`);
        }
        // eslint-disable-next-line no-await-in-loop
        const stay = await getActiveStay(pg, p.id);
        if (stay) // eslint-disable-next-line no-await-in-loop
          await releaseStay(pg, id, stay.id, date, 'checkout', operator);
        // eslint-disable-next-line no-await-in-loop
        await pg.query(
          `INSERT INTO ceremony_checkins (ceremony_id, participant_id, checkout_date, checkout_early, recorded_by)
           VALUES ($1,$2,$3,false,$4)
           ON CONFLICT (participant_id) DO UPDATE SET checkout_date=EXCLUDED.checkout_date, checkout_early=false`,
          [id, p.id, date, operator],
        );
        // eslint-disable-next-line no-await-in-loop
        await pg.query(`UPDATE ceremony_participants SET status='checked_out' WHERE id=$1`, [p.id]);
        // eslint-disable-next-line no-await-in-loop
        await logEvent(pg, id, 'checkout', { date }, operator, p.id);
      }
      const promoted = await runPromotions(pg, id, operator);
      await pg.query('COMMIT');
      return { ok: true, total: ps.length, promoted };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 法会结束：批量释放全部床位 ----------------
  app.post<{ Params: { id: string } }>('/:id/release-all', async (req) => {
    const { id } = req.params;
    const b = req.body as { date?: string; operator?: string };
    const date = b.date ? checkDate(b.date, '日期') : today();
    const operator = b.operator ?? '知客';
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      await getCeremony(pg, id, true);
      const stays = await txMany<{ id: string; participant_id: string }>(
        pg,
        `SELECT id, participant_id FROM ceremony_bed_stays
         WHERE ceremony_id=$1 AND status<>'released' FOR UPDATE`,
        [id],
      );
      for (const s of stays) {
        // eslint-disable-next-line no-await-in-loop
        await releaseStay(pg, id, s.id, date, 'release_all', operator);
      }
      // 在寺签到者一并办离寺；bed_offered 回到 registered；候补不再递补
      await pg.query(
        `INSERT INTO ceremony_checkins (ceremony_id, participant_id, checkout_date, recorded_by)
         SELECT $1, p.id, $2, $3 FROM ceremony_participants p
         WHERE p.ceremony_id=$1 AND p.status='checked_in'
         ON CONFLICT (participant_id)
         DO UPDATE SET checkout_date=EXCLUDED.checkout_date`,
        [id, date, operator],
      );
      const { rows: chk } = await pg.query(
        `UPDATE ceremony_participants SET status='checked_out'
         WHERE ceremony_id=$1 AND status='checked_in' RETURNING id`,
        [id],
      );
      await pg.query(
        `UPDATE ceremony_participants SET status='registered'
         WHERE ceremony_id=$1 AND status='bed_offered'`,
        [id],
      );
      await logEvent(pg, id, 'release_all', { released: stays.length, checked_out: chk.length, date }, operator);
      await pg.query('COMMIT');
      return { ok: true, released: stays.length, checked_out: chk.length };
    } catch (e) {
      await pg.query('ROLLBACK'); throw pgConflict(e) ?? e;
    } finally {
      pg.release();
    }
  });

  // ---------------- 统计：实到率 / 床位峰值 / 每日入住趋势 ----------------
  app.get<{ Params: { id: string } }>('/:id/reports', async (req) => {
    const { id } = req.params;
    const c = await one(`SELECT * FROM dharma_ceremonies WHERE id=$1`, [id]);
    if (!c) throw new ApiError(404, '法会不存在');

    const counts = await one<{
      expected_total: number; arrived_total: number; on_time_count: number;
      late_count: number; no_show_count: number; early_left_count: number;
      cancelled_count: number; still_waitlisted: number; staying_count: number;
    }>(
      `
      SELECT
        count(*) FILTER (WHERE p.status<>'cancelled')::int AS expected_total,
        count(*) FILTER (WHERE ck.checkin_date IS NOT NULL)::int AS arrived_total,
        count(*) FILTER (WHERE ck.checkin_kind='on_time')::int AS on_time_count,
        count(*) FILTER (WHERE ck.checkin_kind='late')::int AS late_count,
        count(*) FILTER (WHERE p.status='no_show')::int AS no_show_count,
        count(*) FILTER (WHERE p.status='early_left')::int AS early_left_count,
        count(*) FILTER (WHERE p.status='cancelled')::int AS cancelled_count,
        count(*) FILTER (WHERE p.status='waitlisted')::int AS still_waitlisted,
        count(*) FILTER (WHERE p.status='checked_in')::int AS staying_count
      FROM ceremony_participants p
      LEFT JOIN ceremony_checkins ck ON ck.participant_id=p.id
      WHERE p.ceremony_id=$1`,
      [id],
    );
    const arrivedRate = counts.expected_total
      ? Math.round((counts.arrived_total / counts.expected_total) * 1000) / 10
      : 0;

    // 每日床位占用：released 占用至 actual_end（实际释放前一日），未释出按计划 stay_end
    const daily = await many<{ date: string; beds_occupied: number }>(
      `
      SELECT d.d::date AS date, count(s.*)::int AS beds_occupied
      FROM generate_series($2::date, $3::date, INTERVAL '1 day') d(d)
      LEFT JOIN ceremony_bed_stays s
        ON s.ceremony_id=$1
       AND d.d::date BETWEEN s.stay_start AND coalesce(s.actual_end, s.stay_end)
      GROUP BY d.d ORDER BY d.d`,
      [id, c.start_date, c.end_date],
    );
    const peak = daily.reduce((m, x) => Math.max(m, x.beds_occupied), 0);
    const peakDate = daily.find((x) => x.beds_occupied === peak)?.date ?? null;
    const bedNights = daily.reduce((s, x) => s + x.beds_occupied, 0);

    // 状态分布
    const statusDist = await many<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM ceremony_participants
       WHERE ceremony_id=$1 GROUP BY status ORDER BY n DESC`,
      [id],
    );

    return {
      ...counts,
      arrived_rate: arrivedRate,
      daily_occupancy: daily,
      bed_peak: peak,
      bed_peak_date: peakDate,
      bed_nights: bedNights,
      capacity: c.capacity,
      status_dist: statusDist,
    };
  });

  // ---------------- 操作留痕 ----------------
  app.get<{ Params: { id: string } }>('/:id/events', async (req) => {
    const { type } = req.query as { type?: string };
    const conds = ['e.ceremony_id=$1'];
    const params: unknown[] = [req.params.id];
    if (type) {
      params.push(type);
      conds.push(`e.event_type=$${params.length}::ceremony_event_type`);
    }
    return many(
      `
      SELECT e.*, p.dharma_name
      FROM ceremony_event_log e
      LEFT JOIN ceremony_participants p ON p.id=e.participant_id
      WHERE ${conds.join(' AND ')}
      ORDER BY e.created_at DESC, e.id DESC
      LIMIT 500`,
      params,
    );
  });

  // ---------------- 导入批次（逐行结果完整保留） ----------------
  app.get<{ Params: { id: string } }>('/:id/import-batches', async (req) => {
    return many(
      `SELECT id, file_name, total_rows, accepted_count, waitlisted_count,
              duplicate_count, conflict_count, capacity_count, invalid_count,
              imported_by, created_at
       FROM ceremony_import_batches WHERE ceremony_id=$1
       ORDER BY created_at DESC`,
      [req.params.id],
    );
  });

  app.get<{ Params: { id: string; bid: string } }>('/:id/import-batches/:bid', async (req) => {
    const row = await one(
      'SELECT * FROM ceremony_import_batches WHERE id=$1 AND ceremony_id=$2',
      [req.params.bid, req.params.id],
    );
    if (!row) throw new ApiError(404, '导入批次不存在');
    return row;
  });
};

export default routes;
