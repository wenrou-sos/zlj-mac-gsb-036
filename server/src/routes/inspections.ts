import type { FastifyPluginAsync } from 'fastify';
import { pool, many, one, ApiError, asEnum, INSPECTION_RESULTS } from '../db.js';
import type { DTO } from '../db.js';

/**
 * 羯磨转常住资格核对：
 *  1. 考察仍在进行中（result=pending）
 *  2. 已完成月度阶段汇总次数达到规定评议次数
 *  3. 无缺席待补评（评议名册中人人有票）
 *  4. 无未处理缺勤提醒（absence_alerts 无 open）
 *  5. 历次月度评议均分达到达标分
 * 必须全部满足方可发起羯磨；pass 接口会在事务内再次核对。
 */
export interface EligibilityCheck {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Eligibility {
  inspection_id: string;
  result: string;
  required_reviews: number;
  completed_reviews: number;
  total_rounds: number;
  overall_avg: number | null;
  pass_score: number;
  open_alert_count: number;
  makeup_pending: number;
  missing_reviewers: { round_id: string; seq_no: number; reviewer_name: string; reviewer_role: string | null }[];
  checks: EligibilityCheck[];
  eligible: boolean;
}

export async function getEligibility(client: Pick<typeof pool, 'query'>, inspectionId: string): Promise<Eligibility> {
  const q = async <T = DTO>(sql: string, params: unknown[] = []): Promise<T> => {
    const { rows } = await client.query(sql, params);
    return rows[0] as T;
  };
  const qm = async <T = DTO>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const { rows } = await client.query(sql, params);
    return rows as T[];
  };

  const insp = await q<{
    id: string; result: string; required_reviews: number; pass_score: number;
  }>(`SELECT id, result, required_reviews, pass_score FROM inspections WHERE id=$1`, [inspectionId]);
  if (!insp) throw new ApiError(404, '考察记录不存在');

  const stats = await q<{
    completed_rounds: number; total_rounds: number; overall_avg: number | null;
    open_alert_count: number; makeup_pending: number;
  }>(`
    SELECT
      (SELECT count(*) FROM review_rounds WHERE inspection_id=i.id AND status='summarized')::int AS completed_rounds,
      (SELECT count(*) FROM review_rounds WHERE inspection_id=i.id)::int AS total_rounds,
      (SELECT round(avg(average_score), 2) FROM review_rounds
         WHERE inspection_id=i.id AND status='summarized') AS overall_avg,
      (SELECT count(*) FROM absence_alerts WHERE monk_id=i.monk_id AND status='open')::int AS open_alert_count,
      (SELECT count(*)
         FROM review_reviewers rv
         JOIN review_rounds rr ON rr.id = rv.round_id
         LEFT JOIN review_scores s ON s.round_id = rv.round_id AND s.reviewer_id = rv.reviewer_id
        WHERE rr.inspection_id = i.id AND s.id IS NULL)::int AS makeup_pending
    FROM inspections i WHERE i.id=$1
  `, [inspectionId]);

  const missing = await qm<{ round_id: string; seq_no: number; reviewer_name: string; reviewer_role: string | null }>(`
    SELECT rv.round_id, rr.seq_no, rv.reviewer_name, rv.reviewer_role
    FROM review_reviewers rv
    JOIN review_rounds rr ON rr.id = rv.round_id
    LEFT JOIN review_scores s ON s.round_id = rv.round_id AND s.reviewer_id = rv.reviewer_id
    WHERE rr.inspection_id=$1 AND s.id IS NULL
    ORDER BY rr.seq_no, rv.seat_no
  `, [inspectionId]);

  const checks: EligibilityCheck[] = [
    {
      key: 'reviews_met',
      label: `规定月度评议次数已满（${insp.required_reviews} 次）`,
      ok: stats.completed_rounds >= insp.required_reviews,
      detail: `已完成阶段汇总 ${stats.completed_rounds}/${insp.required_reviews} 次`,
    },
    {
      key: 'no_makeup_pending',
      label: '无缺席待补评',
      ok: stats.makeup_pending === 0,
      detail: stats.makeup_pending === 0
        ? '各月评议名册均已投齐'
        : missing.map((m) => `${m.reviewer_name}（第${m.seq_no}月）`).join('、') + ' 缺席待补评',
    },
    {
      key: 'no_open_alert',
      label: '无未处理缺勤提醒',
      ok: stats.open_alert_count === 0,
      detail: stats.open_alert_count === 0
        ? '客堂缺勤待办 0 件'
        : `尚有 ${stats.open_alert_count} 件缺勤提醒待知客知悉处理`,
    },
    {
      key: 'score_reached',
      label: `历次评议均分达标（≥${insp.pass_score}）`,
      ok: stats.overall_avg !== null && Number(stats.overall_avg) >= Number(insp.pass_score),
      detail: stats.overall_avg === null ? '尚无已汇总的月度评议' : `历次阶段均分 ${stats.overall_avg}`,
    },
  ];

  return {
    inspection_id: inspectionId,
    result: insp.result,
    required_reviews: insp.required_reviews,
    completed_reviews: stats.completed_rounds,
    total_rounds: stats.total_rounds,
    overall_avg: stats.overall_avg,
    pass_score: Number(insp.pass_score),
    open_alert_count: stats.open_alert_count,
    makeup_pending: stats.makeup_pending,
    missing_reviewers: missing,
    checks,
    eligible:
      insp.result === 'pending' &&
      checks.every((c) => c.ok),
  };
}

const routes: FastifyPluginAsync = async (app) => {
  // 考察期列表（附带月度评议进度）
  app.get('/', async (req) => {
    const { result } = req.query as { result?: string };
    const conds: string[] = [];
    const params: unknown[] = [];
    if (result) {
      params.push(asEnum(result, INSPECTION_RESULTS, '考察结果'));
      conds.push(`i.result = $${params.length}::inspection_result`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return many(`
      SELECT i.*, m.dharma_name, m.ordination_no,
             (CURRENT_DATE - i.start_date)::int AS days_elapsed,
             (SELECT count(*) FROM review_rounds
               WHERE inspection_id=i.id AND status='summarized')::int AS completed_rounds,
             (SELECT count(*) FROM review_rounds
               WHERE inspection_id=i.id)::int AS total_rounds,
             (SELECT round(avg(average_score), 2) FROM review_rounds
               WHERE inspection_id=i.id AND status='summarized') AS overall_avg,
             (SELECT count(*)
                FROM review_reviewers rv
                JOIN review_rounds rr ON rr.id=rv.round_id
                LEFT JOIN review_scores s ON s.round_id=rv.round_id AND s.reviewer_id=rv.reviewer_id
               WHERE rr.inspection_id=i.id AND s.id IS NULL)::int AS makeup_pending,
             (SELECT count(*) FROM absence_alerts
               WHERE monk_id=i.monk_id AND status='open')::int AS open_alert_count
      FROM inspections i
      JOIN monks m ON m.id = i.monk_id
      ${where}
      ORDER BY CASE i.result WHEN 'pending' THEN 0 ELSE 1 END, i.start_date DESC
    `, params);
  });

  // 发心常住：挂单转入考察期（3-6 个月），可规定评议次数与达标分
  app.post('/', async (req, reply) => {
    const { guadan_id, start_date, duration_months, required_reviews, pass_score, note } = req.body as {
      guadan_id?: string;
      start_date?: string;
      duration_months?: number;
      required_reviews?: number;
      pass_score?: number;
      note?: string | null;
    };
    if (!guadan_id) throw new ApiError(400, '缺少挂单记录');
    if (!start_date) throw new ApiError(400, '缺少考察开始日期');
    if (!duration_months || duration_months < 3 || duration_months > 6) {
      throw new ApiError(400, '考察期须为 3-6 个月');
    }
    const reqReviews = required_reviews ?? duration_months;
    if (!Number.isInteger(reqReviews) || reqReviews < 1 || reqReviews > duration_months) {
      throw new ApiError(400, `规定评议次数须为 1-${duration_months} 的整数`);
    }
    const minScore = pass_score ?? 75;
    if (typeof minScore !== 'number' || minScore < 0 || minScore > 100) {
      throw new ApiError(400, '达标分须在 0-100 之间');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: gs } = await client.query(
        "SELECT monk_id FROM guadan WHERE id=$1 AND status='active'",
        [guadan_id],
      );
      if (gs.length === 0) throw new ApiError(404, '有效挂单记录不存在');
      const monkId = gs[0].monk_id as string;

      const { rows: exist } = await client.query(
        "SELECT 1 FROM inspections WHERE monk_id=$1 AND result='pending'",
        [monkId],
      );
      if (exist.length) throw new ApiError(409, '该僧人已在考察期中');

      const { rows } = await client.query(
        `INSERT INTO inspections
           (monk_id, guadan_id, start_date, expected_end,
            required_reviews, pass_score, note)
         VALUES ($1, $2, $3, ($3::date + ($4 || ' months')::interval)::date, $5, $6, $7)
         RETURNING *`,
        [monkId, guadan_id, start_date, duration_months, reqReviews, minScore, note ?? null],
      );
      await client.query("UPDATE monks SET status='inspection' WHERE id=$1", [monkId]);
      await client.query('COMMIT');
      return reply.code(201).send(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 考察参数调整（仅考察中）：规定评议次数 / 达标分
  app.put<{ Params: { id: string } }>('/:id', async (req) => {
    const { required_reviews, pass_score } = req.body as {
      required_reviews?: number;
      pass_score?: number;
    };
    const sets: string[] = [];
    const params: unknown[] = [req.params.id];
    if (required_reviews !== undefined) {
      if (!Number.isInteger(required_reviews) || required_reviews < 1 || required_reviews > 12) {
        throw new ApiError(400, '规定评议次数须为 1-12 的整数');
      }
      params.push(required_reviews);
      sets.push(`required_reviews = $${params.length}`);
    }
    if (pass_score !== undefined) {
      if (typeof pass_score !== 'number' || pass_score < 0 || pass_score > 100) {
        throw new ApiError(400, '达标分须在 0-100 之间');
      }
      params.push(pass_score);
      sets.push(`pass_score = $${params.length}`);
    }
    if (sets.length === 0) throw new ApiError(400, '没有需要更新的字段');
    const row = await one(
      `UPDATE inspections SET ${sets.join(', ')}
        WHERE id=$1 AND result='pending' RETURNING *`,
      params,
    );
    if (!row) throw new ApiError(404, '考察中记录不存在（已结案件不可修改）');
    return row;
  });

  // 羯磨资格核对（不产生副作用，前端按钮态与对框清单共用）
  app.get<{ Params: { id: string } }>('/:id/eligibility', async (req) =>
    getEligibility(pool, req.params.id),
  );

  // 考察通过：行羯磨转常住 —— 四项门槛全部满足方可发起，并落决策快照
  app.post<{ Params: { id: string } }>('/:id/pass', async (req) => {
    const { karma_date, current_post, note, decided_by } = req.body as {
      karma_date?: string; current_post?: string | null; note?: string | null; decided_by?: string;
    };
    if (!karma_date) throw new ApiError(400, '请填写羯磨仪式日期');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 行锁 + 资格复核（防止收评分/缺勤提醒并发变化）
      const locked = await client.query(
        'SELECT id FROM inspections WHERE id=$1 FOR UPDATE',
        [req.params.id],
      );
      if (locked.rows.length === 0) throw new ApiError(404, '考察记录不存在');
      const elig = await getEligibility(client, req.params.id);
      if (elig.result !== 'pending') throw new ApiError(409, '该考察已有结论，不可重复发起羯磨');
      if (!elig.eligible) {
        throw new ApiError(
          422,
          '羯磨条件尚未具足：' + elig.checks.filter((c) => !c.ok).map((c) => c.label).join('；'),
        );
      }

      // 组装完整决策快照：逐月、逐执事评分、逐条修订留痕（均走事务连接）
      const { rows: inspRows } = await client.query<{
        id: string; monk_id: string; required_reviews: number; pass_score: number;
        stage_summary: string | null;
      }>(`SELECT id, monk_id, required_reviews, pass_score, stage_summary
          FROM inspections WHERE id=$1`, [req.params.id]);
      const insp = inspRows[0];
      const { rows: monkRows } = await client.query<{ dharma_name: string }>(
        'SELECT dharma_name FROM monks WHERE id=$1',
        [insp.monk_id],
      );
      const monk = monkRows[0];
      const { rows: rounds } = await client.query(
        'SELECT * FROM review_rounds WHERE inspection_id=$1 ORDER BY seq_no',
        [req.params.id],
      );
      const { rows: scores } = await client.query(`
        SELECT s.*, rv.reviewer_name, rv.reviewer_role, rv.seat_no
        FROM review_scores s
        JOIN review_reviewers rv ON rv.round_id=s.round_id AND rv.reviewer_id=s.reviewer_id
        JOIN review_rounds rr ON rr.id=s.round_id
        WHERE rr.inspection_id=$1
        ORDER BY rr.seq_no, rv.seat_no
      `, [req.params.id]);
      const { rows: revisions } = await client.query(`
        SELECT sr.*, rr.seq_no
        FROM score_revisions sr
        JOIN review_rounds rr ON rr.id=sr.round_id
        WHERE rr.inspection_id=$1
        ORDER BY rr.seq_no, sr.revised_at
      `, [req.params.id]);

      const roundsJson = rounds.map((r) => ({
        seq_no: r.seq_no,
        period_start: r.period_start,
        period_end: r.period_end,
        meeting_date: r.meeting_date,
        status: r.status,
        average_score: r.average_score,
        conclusion: r.conclusion,
        summary_note: r.summary_note,
        summarized_by: r.summarized_by,
        summarized_at: r.summarized_at,
        scores: scores
          .filter((s) => s.round_id === r.id)
          .map((s) => ({
            reviewer_name: s.reviewer_name,
            reviewer_role: s.reviewer_role,
            score: s.score,
            comment: s.comment,
            submission_type: s.submission_type,
            absent_reason: s.absent_reason,
            submitted_by: s.submitted_by,
            submitted_at: s.submitted_at,
            revisions: revisions
              .filter((v) => v.score_id === s.id)
              .map((v) => ({
                old_score: v.old_score,
                new_score: v.new_score,
                old_comment: v.old_comment,
                new_comment: v.new_comment,
                reason: v.reason,
                revised_by: v.revised_by,
                revised_at: v.revised_at,
              })),
          })),
      }));

      const { rows: snapshotRows } = await client.query<{ id: string }>(`
        INSERT INTO karma_decision_snapshots
          (inspection_id, monk_id, monk_name, karma_date, current_post,
           required_reviews, completed_reviews, overall_avg_score, pass_score,
           open_alert_count, makeup_pending, stage_summary, rounds, eligibility,
           decided_by, note)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16)
        RETURNING id
      `, [
        req.params.id, insp.monk_id, monk.dharma_name, karma_date, current_post ?? null,
        elig.required_reviews, elig.completed_reviews, elig.overall_avg, elig.pass_score,
        elig.open_alert_count, elig.makeup_pending, insp.stage_summary,
        JSON.stringify(roundsJson), JSON.stringify(elig.checks),
        decided_by ?? '羯磨法会', note ?? null,
      ]);
      const snapshotId = snapshotRows[0].id;

      const { rows } = await client.query(
        `UPDATE inspections SET result='passed', karma_date=$2, decided_at=now(),
                note=COALESCE($3, note)
         WHERE id=$1 RETURNING monk_id`,
        [req.params.id, karma_date, note ?? null],
      );
      await client.query(
        "UPDATE monks SET status='permanent', current_post=COALESCE($2, current_post) WHERE id=$1",
        [rows[0].monk_id, current_post ?? null],
      );
      await client.query('COMMIT');
      return { ok: true, snapshot_id: snapshotId };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 考察不通过：回到挂单身份
  app.post<{ Params: { id: string } }>('/:id/fail', async (req) => {
    const { note } = req.body as { note?: string | null };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE inspections SET result='failed', decided_at=now(), note=COALESCE($2, note)
         WHERE id=$1 AND result='pending' RETURNING monk_id`,
        [req.params.id, note ?? null],
      );
      if (rows.length === 0) throw new ApiError(404, '待考察记录不存在');
      await client.query("UPDATE monks SET status='guadan' WHERE id=$1", [rows[0].monk_id]);
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 决策快照列表
  app.get<{ Params: { id: string } }>('/:id/snapshots', async (req) =>
    many(`SELECT id, karma_date, current_post, required_reviews, completed_reviews,
                 overall_avg_score, pass_score, open_alert_count, makeup_pending,
                 decided_by, note, created_at
          FROM karma_decision_snapshots WHERE inspection_id=$1 ORDER BY created_at DESC`,
      [req.params.id]),
  );

  // 决策快照详情（不可变档案）
  app.get<{ Params: { snapshotId: string } }>('/snapshots/:snapshotId', async (req) => {
    const row = await one('SELECT * FROM karma_decision_snapshots WHERE id=$1', [req.params.snapshotId]);
    if (!row) throw new ApiError(404, '决策快照不存在');
    return row;
  });
};

export default routes;
