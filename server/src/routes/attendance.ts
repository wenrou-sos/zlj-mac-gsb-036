import type { FastifyPluginAsync } from 'fastify';
import { many, one, ApiError, asEnum } from '../db.js';

const SESSIONS = ['morning', 'evening'] as const;
const ATT_STATUSES = ['present', 'absent', 'leave'] as const;

interface BulkBody {
  attend_date?: string;
  session?: 'morning' | 'evening';
  recorded_by?: string | null;
  entries?: { monk_id: string; status: 'present' | 'absent' | 'leave'; note?: string | null }[];
}

const routes: FastifyPluginAsync = async (app) => {
  // 某日某课次的考勤名册（在寺众全部列出，未登记 status 为 null）
  app.get('/', async (req) => {
    const { attend_date, session } = req.query as { attend_date?: string; session?: string };
    if (!attend_date || !session) throw new ApiError(400, '请选择日期与课次');
    const sess = asEnum(session, ['morning', 'evening'] as const, '课次');
    return many(`
      SELECT m.id AS monk_id, m.dharma_name, m.status AS monk_status, m.current_post,
             a.id, a.status, a.note, a.recorded_by, a.updated_at
      FROM monks m
      LEFT JOIN attendance a
        ON a.monk_id = m.id AND a.attend_date = $1 AND a.session = $2::session_type
      WHERE m.status IN ('permanent', 'guadan', 'inspection')
      ORDER BY CASE m.status WHEN 'permanent' THEN 0 WHEN 'inspection' THEN 1 ELSE 2 END,
               m.dharma_name
    `, [attend_date, sess]);
  });

  // 某僧人区间内考勤
  app.get<{ Params: { monkId: string } }>('/monk/:monkId', async (req) => {
    const { from, to } = req.query as { from?: string; to?: string };
    return many(`
      SELECT * FROM attendance
      WHERE monk_id = $1 AND attend_date BETWEEN COALESCE($2, CURRENT_DATE - 29) AND COALESCE($3, CURRENT_DATE)
      ORDER BY attend_date DESC, session
    `, [req.params.monkId, from ?? null, to ?? null]);
  });

  // 在寺众近 N 日缺勤统计（满 3 次排在前）
  app.get('/summary', async (req) => {
    const { days } = req.query as { days?: string };
    const n = Math.min(Number(days ?? 30) || 30, 365);
    return many(`
      SELECT m.id AS monk_id, m.dharma_name, m.status AS monk_status, m.current_post,
             count(a.*) FILTER (WHERE a.status = 'absent')::int AS absent_count,
             count(a.*) FILTER (WHERE a.status = 'leave')::int  AS leave_count,
             count(a.*) FILTER (WHERE a.status = 'present')::int AS present_count,
             max(a.attend_date) FILTER (WHERE a.status = 'absent') AS last_absence,
             EXISTS (SELECT 1 FROM absence_alerts al
                     WHERE al.monk_id = m.id AND al.status = 'open') AS has_open_alert
      FROM monks m
      LEFT JOIN attendance a
        ON a.monk_id = m.id AND a.attend_date >= CURRENT_DATE - $1::int
      WHERE m.status IN ('permanent', 'guadan', 'inspection')
      GROUP BY m.id
      ORDER BY absent_count DESC, m.dharma_name
    `, [n - 1]);
  });

  // 单条登记/修改
  app.post('/', async (req, reply) => {
    const { monk_id, attend_date, session, status, note, recorded_by } = req.body as {
      monk_id?: string; attend_date?: string; session?: 'morning' | 'evening';
      status?: 'present' | 'absent' | 'leave'; note?: string | null; recorded_by?: string | null;
    };
    if (!monk_id || !attend_date || !session || !status) throw new ApiError(400, '登记信息不完整');
    const sess = asEnum(session, SESSIONS, '课次');
    const st = asEnum(status, ATT_STATUSES, '考勤状态');
    const row = await one(`
      INSERT INTO attendance (monk_id, attend_date, session, status, note, recorded_by)
      VALUES ($1,$2,$3::session_type,$4::attendance_status,$5,$6)
      ON CONFLICT (monk_id, attend_date, session)
      DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by
      RETURNING *
    `, [monk_id, attend_date, sess, st, note ?? null, recorded_by ?? null]);
    return reply.code(201).send(row);
  });

  // 整堂批量登记（早课/晚课一次性提交）
  app.post('/bulk', async (req) => {
    const body = req.body as BulkBody;
    if (!body.attend_date || !body.session || !body.entries?.length) {
      throw new ApiError(400, '登记信息不完整');
    }
    const sess = asEnum(body.session, SESSIONS, '课次');
    let upserted = 0;
    for (const e of body.entries) {
      if (!e.monk_id || !e.status) continue;
      const st = asEnum(e.status, ATT_STATUSES, '考勤状态');
      await one(`
        INSERT INTO attendance (monk_id, attend_date, session, status, note, recorded_by)
        VALUES ($1,$2,$3::session_type,$4::attendance_status,$5,$6)
        ON CONFLICT (monk_id, attend_date, session)
        DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by
      `, [e.monk_id, body.attend_date, sess, st, e.note ?? null, body.recorded_by ?? null]);
      upserted++;
    }
    return { ok: true, upserted };
  });
};

export default routes;
