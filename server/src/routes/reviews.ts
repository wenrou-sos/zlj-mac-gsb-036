import type { FastifyPluginAsync } from 'fastify';
import { pool, many, one, ApiError, asEnum, SUBMISSION_TYPES, REVIEW_CONCLUSIONS } from '../db.js';

/** 取会次并校验其所属考察仍在进行（已汇总会次默认不可改，force=true 时放开） */
async function lockRound(
  client: Pick<typeof pool, 'query'>,
  roundId: string,
  opts: { mustBeCollecting?: boolean } = {},
) {
  const round = await one<{
    id: string; inspection_id: string; seq_no: number; status: string;
  }>(`SELECT rr.id, rr.inspection_id, rr.seq_no, rr.status
      FROM review_rounds rr
      JOIN inspections i ON i.id = rr.inspection_id
      WHERE rr.id=$1 AND i.result='pending'`,
    [roundId]);
  if (!round) throw new ApiError(404, '会次不存在或所属考察已结案');
  if (opts.mustBeCollecting && round.status !== 'collecting') {
    throw new ApiError(409, '该月评议已作阶段汇总，请先撤销汇总后再修改');
  }
  return round;
}

/** 可担任评议人的核心执事（知客/维那/典座/僧值等，不含方丈与普通悦众） */
const REVIEWER_SQL = `
  SELECT id, dharma_name, current_post
  FROM monks
  WHERE status='permanent'
    AND current_post IN ('首座','西堂','后堂','堂主','知客','维那','典座',
                         '僧值','寮元','书记','衣钵','汤药')
  ORDER BY CASE current_post
             WHEN '首座' THEN 1 WHEN '知客' THEN 2
             WHEN '维那' THEN 3 WHEN '僧值' THEN 4 ELSE 5 END, dharma_name
`;

const routes: FastifyPluginAsync = async (app) => {
  // 可选评议执事
  app.get('/reviewers', async () => many(REVIEWER_SQL));

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function asUuid(value: unknown, label: string): string {
    if (typeof value === 'string' && UUID_RE.test(value)) return value;
    throw new ApiError(400, `无效的${label}标识`);
  }

  // 某条考察下的全部月度会次（含名册、评分、修订）
  app.get('/inspections/:id/rounds', async (req) => {
    const { id } = req.params as { id: string };
    const rounds = await many(`
      SELECT rr.*,
             (SELECT count(*) FROM review_scores s WHERE s.round_id=rr.id)::int AS score_count
      FROM review_rounds rr
      WHERE rr.inspection_id=$1
      ORDER BY rr.seq_no
    `, [id]);
    if (rounds.length === 0) return [];

    const reviewers = await many(`
      SELECT rv.*, s.id AS score_id, s.score, s.comment, s.submission_type,
             s.absent_reason, s.submitted_by, s.submitted_at, s.updated_at
      FROM review_reviewers rv
      JOIN review_rounds rr ON rr.id=rv.round_id
      LEFT JOIN review_scores s ON s.round_id=rv.round_id AND s.reviewer_id=rv.reviewer_id
      WHERE rr.inspection_id=$1
      ORDER BY rr.seq_no, rv.seat_no
    `, [id]);
    const revisions = await many(`
      SELECT v.*, rr.seq_no FROM score_revisions v
      JOIN review_rounds rr ON rr.id=v.round_id
      WHERE rr.inspection_id=$1
      ORDER BY rr.seq_no, v.revised_at
    `, [id]);

    return rounds.map((r) => ({
      ...r,
      reviewers: reviewers
        .filter((rv) => rv.round_id === r.id)
        .map((rv) => {
          const { round_id: _roundId, ...rest } = rv;
          return {
            ...rest,
            revisions: revisions.filter((v) => v.score_id === rv.score_id),
          };
        }),
    }));
  });

  // 召集一次月度评议会（名册从当前常住执事中点选，默认全带）
  app.post('/inspections/:id/rounds', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { period_start, period_end, meeting_date, reviewer_ids, note } = req.body as {
      period_start?: string;
      period_end?: string;
      meeting_date?: string;
      reviewer_ids?: string[];
      note?: string | null;
    };
    if (!period_start || !period_end || !meeting_date) {
      throw new ApiError(400, '请填写评议区间与会议日期');
    }
    if (period_end < period_start) throw new ApiError(400, '评议区间止日不得早于起日');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insp = await one<{ id: string; start_date: string; expected_end: string; result: string }>(
        'SELECT id, start_date, expected_end, result FROM inspections WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (!insp) throw new ApiError(404, '考察记录不存在');
      if (insp.result !== 'pending') throw new ApiError(409, '考察已结案，不可再召集评议');
      if (meeting_date < insp.start_date || meeting_date > insp.expected_end) {
        throw new ApiError(400, '会议日期须在考察期之内');
      }

      const last = await one<{ seq_no: number; status: string }>(
        'SELECT seq_no, status FROM review_rounds WHERE inspection_id=$1 ORDER BY seq_no DESC LIMIT 1',
        [id],
      );
      if (last && last.status !== 'summarized') {
        throw new ApiError(409, `第 ${last.seq_no} 月评议尚在收评分中，请先作阶段汇总`);
      }
      const seqNo = (last?.seq_no ?? 0) + 1;

      let pickedIds: string[] = [];
      if (Array.isArray(reviewer_ids) && reviewer_ids.length > 0) {
        pickedIds = [...new Set(reviewer_ids)].map((id) => asUuid(id, '评议执事'));
      } else {
        pickedIds = (await many<{ id: string }>(REVIEWER_SQL)).map((r) => r.id);
      }
      if (pickedIds.length < 2) throw new ApiError(400, '月度评议至少须两位执事参与');

      const { rows } = await client.query(
        `INSERT INTO review_rounds (inspection_id, seq_no, period_start, period_end, meeting_date, note)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [id, seqNo, period_start, period_end, meeting_date, note ?? null],
      );
      const roundId = rows[0].id as string;

      const roster = await client.query(
        `SELECT id, dharma_name, current_post FROM monks
          WHERE status='permanent' AND id = ANY($1::uuid[])`,
        [pickedIds],
      );
      if (roster.rows.length !== pickedIds.length) {
        throw new ApiError(400, '评议名册中存在非在寺常住');
      }
      for (let i = 0; i < roster.rows.length; i++) {
        const m = roster.rows[i];
        await client.query(
          `INSERT INTO review_reviewers (round_id, reviewer_id, reviewer_name, reviewer_role, seat_no)
           VALUES ($1,$2,$3,$4,$5)`,
          [roundId, m.id, m.dharma_name, m.current_post, i + 1],
        );
      }
      await client.query('COMMIT');
      return reply.code(201).send(rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 调整会次区间/会议日期（仅收评分中）
  app.put<{ Params: { roundId: string } }>('/rounds/:roundId', async (req) => {
    const { period_start, period_end, meeting_date } = req.body as {
      period_start?: string; period_end?: string; meeting_date?: string;
    };
    const sets: string[] = [];
    const params: unknown[] = [req.params.roundId];
    for (const [col, val] of [['period_start', period_start], ['period_end', period_end], ['meeting_date', meeting_date]] as const) {
      if (val !== undefined) {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      }
    }
    if (!sets.length) throw new ApiError(400, '没有需要更新的字段');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockRound(client, req.params.roundId, { mustBeCollecting: true });
      const row = (await client.query(
        `UPDATE review_rounds SET ${sets.join(', ')} WHERE id=$1 RETURNING *`,
        params,
      )).rows[0];
      await client.query('COMMIT');
      return row;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 执事提交独立评分（同一人同一会次仅一票，重复提交即视为修订）
  app.post<{ Params: { roundId: string } }>('/rounds/:roundId/scores', async (req) => {
    const { reviewer_id, score, comment, submission_type, absent_reason, submitted_by } = req.body as {
      reviewer_id?: string;
      score?: number;
      comment?: string | null;
      submission_type?: string;
      absent_reason?: string | null;
      submitted_by?: string;
    };
    if (!reviewer_id) throw new ApiError(400, '缺少评分执事');
    asUuid(reviewer_id, '执事');
    if (typeof score !== 'number' || score < 0 || score > 100) throw new ApiError(400, '评分须在 0-100 之间');
    const stype = asEnum(submission_type ?? 'normal', SUBMISSION_TYPES, '提交方式');
    if (stype === 'makeup' && !absent_reason?.trim()) {
      throw new ApiError(400, '缺席补评须填写缺席事由');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const round = await lockRound(client, req.params.roundId, { mustBeCollecting: true });

      const roster = await one<{ id: string; reviewer_name: string }>(
        'SELECT id, reviewer_name FROM review_reviewers WHERE round_id=$1 AND reviewer_id=$2',
        [req.params.roundId, reviewer_id],
      );
      if (!roster) throw new ApiError(400, '该执事不在本月评议名册中');

      const existing = await one<{ id: string; score: number; comment: string | null; submission_type: string }>(
        'SELECT id, score, comment, submission_type FROM review_scores WHERE round_id=$1 AND reviewer_id=$2',
        [req.params.roundId, reviewer_id],
      );
      if (existing) {
        // 已投过票：本次按"评语/评分修订"处理并留痕
        await client.query(
          `UPDATE review_scores SET score=$2, comment=$3, updated_at=now()
           WHERE id=$1`,
          [existing.id, score, comment ?? null],
        );
        await client.query(
          `INSERT INTO score_revisions
             (score_id, round_id, reviewer_id, reviewer_name,
              old_score, new_score, old_comment, new_comment,
              reason, revised_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            existing.id, req.params.roundId, reviewer_id, roster.reviewer_name,
            existing.score, score, existing.comment, comment ?? null,
            stype === 'makeup'
              ? `缺席补评后修订：${absent_reason ?? ''}`
              : '执事修订本月评分/评语',
            submitted_by ?? '知客',
          ],
        );
      } else {
        await client.query(
          `INSERT INTO review_scores (round_id, reviewer_id, score, comment,
                                       submission_type, absent_reason, submitted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [req.params.roundId, reviewer_id, score, comment ?? null,
           stype, stype === 'makeup' ? absent_reason : null, submitted_by ?? '知客'],
        );
      }
      await client.query('COMMIT');
      return { ok: true, seq_no: round.seq_no };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 评语修订（对已投票单独留痕修订；与提交接口共用留痕逻辑，便于只改评语时明示缘由）
  app.put<{ Params: { scoreId: string } }>('/scores/:scoreId/revisions', async (req) => {
    const { score, comment, reason, revised_by } = req.body as {
      score?: number;
      comment?: string | null;
      reason?: string;
      revised_by?: string;
    };
    if (score !== undefined && (typeof score !== 'number' || score < 0 || score > 100)) {
      throw new ApiError(400, '评分须在 0-100 之间');
    }
    if (!reason?.trim()) throw new ApiError(400, '修订须填写缘由，以备查核');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const old = await one<{
        id: string; round_id: string; reviewer_id: string;
        score: number; comment: string | null;
      }>(`SELECT s.id, s.round_id, s.reviewer_id, s.score, s.comment
          FROM review_scores s
          JOIN review_rounds rr ON rr.id=s.round_id
          JOIN inspections i ON i.id=rr.inspection_id
          WHERE s.id=$1 AND i.result='pending' FOR UPDATE OF s`,
        [req.params.scoreId]);
      if (!old) throw new ApiError(404, '评分不存在或考察已结案');
      await lockRound(client, old.round_id, { mustBeCollecting: true });

      const rv = await one<{ reviewer_name: string }>(
        'SELECT reviewer_name FROM review_reviewers WHERE round_id=$1 AND reviewer_id=$2',
        [old.round_id, old.reviewer_id],
      );
      const newScore = score ?? old.score;
      const newComment = comment === undefined ? old.comment : comment;
      await client.query(
        'UPDATE review_scores SET score=$2, comment=$3, updated_at=now() WHERE id=$1',
        [old.id, newScore, newComment ?? null],
      );
      await client.query(
        `INSERT INTO score_revisions
           (score_id, round_id, reviewer_id, reviewer_name,
            old_score, new_score, old_comment, new_comment, reason, revised_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [old.id, old.round_id, old.reviewer_id, rv.reviewer_name,
         old.score, newScore, old.comment, newComment ?? null,
         reason, revised_by ?? '知客'],
      );
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 阶段汇总：当月评分齐备后锁定均分与结论；末次汇总时一并形成考察阶段总评
  app.post<{ Params: { roundId: string } }>('/rounds/:roundId/summarize', async (req) => {
    const { conclusion, summary_note, stage_summary, summarized_by } = req.body as {
      conclusion?: string;
      summary_note?: string | null;
      stage_summary?: string | null;
      summarized_by?: string;
    };
    const concl = asEnum(conclusion ?? 'qualified', REVIEW_CONCLUSIONS, '评议结论');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const round = await lockRound(client, req.params.roundId, { mustBeCollecting: true });

      const rosterCount = await one<{ n: number }>(
        'SELECT count(*)::int AS n FROM review_reviewers WHERE round_id=$1',
        [req.params.roundId],
      );
      const scoreCount = await one<{ n: number }>(
        'SELECT count(*)::int AS n FROM review_scores WHERE round_id=$1',
        [req.params.roundId],
      );
      if (scoreCount.n < rosterCount.n) {
        throw new ApiError(409, `尚有 ${rosterCount.n - scoreCount.n} 位执事未评分（缺席者可走缺席补评），暂不能汇总`);
      }
      const avg = await one<{ avg: number }>(
        'SELECT round(avg(score), 2) AS avg FROM review_scores WHERE round_id=$1',
        [req.params.roundId],
      );

      await client.query(
        `UPDATE review_rounds
            SET status='summarized', average_score=$2, conclusion=$3,
                summary_note=$4, summarized_by=$5, summarized_at=now()
          WHERE id=$1`,
        [req.params.roundId, avg.avg, concl, summary_note ?? null, summarized_by ?? '知客'],
      );
      // 末次月度汇总时形成/更新考察阶段总评
      if (stage_summary !== undefined) {
        await client.query(
          'UPDATE inspections SET stage_summary=$2 WHERE id=$1',
          [round.inspection_id, stage_summary || null],
        );
      }
      await client.query('COMMIT');
      return { ok: true, average_score: avg.avg, conclusion: concl };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 撤销当月汇总（发现疏漏时退回收评分状态；羯磨后不可撤）
  app.post<{ Params: { roundId: string } }>('/rounds/:roundId/reopen', async (req) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const round = await lockRound(client, req.params.roundId);
      if (round.status !== 'summarized') throw new ApiError(409, '该会次尚未汇总');
      await client.query(
        `UPDATE review_rounds
            SET status='collecting', average_score=NULL, conclusion=NULL,
                summarized_by=NULL, summarized_at=NULL
          WHERE id=$1`,
        [req.params.roundId],
      );
      await client.query(
        'UPDATE inspections SET stage_summary=NULL WHERE id=$1',
        [round.inspection_id],
      );
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 某条考察的阶段汇总总览（逐月均分、结论、历次总均分、最近修订）
  app.get('/inspections/:id/summary', async (req) => {
    const { id } = req.params as { id: string };
    const rounds = await many(`
      SELECT seq_no, meeting_date, period_start, period_end, status,
             average_score, conclusion, summary_note, summarized_by, summarized_at,
             (SELECT count(*) FROM review_scores s WHERE s.round_id=rr.id)::int AS score_count,
             (SELECT count(*) FROM review_reviewers v WHERE v.round_id=rr.id)::int AS roster_count
      FROM review_rounds rr WHERE inspection_id=$1 ORDER BY seq_no
    `, [id]);
    const overall = await one<{
      required_reviews: number; pass_score: number; stage_summary: string | null;
      completed: number; overall_avg: number | null;
      makeup_pending: number; revisions: number;
    }>(`
      SELECT i.required_reviews, i.pass_score, i.stage_summary,
             (SELECT count(*) FROM review_rounds WHERE inspection_id=i.id AND status='summarized')::int AS completed,
             (SELECT round(avg(average_score),2) FROM review_rounds
               WHERE inspection_id=i.id AND status='summarized') AS overall_avg,
             (SELECT count(*) FROM review_reviewers rv
                JOIN review_rounds rr2 ON rr2.id=rv.round_id
                LEFT JOIN review_scores s ON s.round_id=rv.round_id AND s.reviewer_id=rv.reviewer_id
               WHERE rr2.inspection_id=i.id AND s.id IS NULL)::int AS makeup_pending,
             (SELECT count(*) FROM score_revisions v
                JOIN review_rounds rr3 ON rr3.id=v.round_id
               WHERE rr3.inspection_id=i.id)::int AS revisions
      FROM inspections i WHERE i.id=$1
    `, [id]);
    if (!overall) throw new ApiError(404, '考察记录不存在');
    return { ...overall, rounds };
  });
};

export default routes;
