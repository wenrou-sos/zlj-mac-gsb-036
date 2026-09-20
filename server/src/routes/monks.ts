import type { FastifyPluginAsync } from 'fastify';
import { many, one, ApiError, asEnum, MONK_STATUSES } from '../db.js';

const routes: FastifyPluginAsync = async (app) => {
  // 僧人列表（可按状态/法名/戒牒编号检索）
  app.get('/', async (req) => {
    const { status, q } = req.query as { status?: string; q?: string };
    const conds: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(asEnum(status, MONK_STATUSES, '僧人状态'));
      conds.push(`m.status = $${params.length}::monk_status`);
    }
    if (q?.trim()) {
      params.push(`%${q.trim()}%`);
      conds.push(`(m.dharma_name ILIKE $${params.length}
                  OR m.ordination_no ILIKE $${params.length}
                  OR m.home_monastery ILIKE $${params.length})`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return many(`
      SELECT m.*, r.room_no, b.bed_no
      FROM monks m
      LEFT JOIN beds b ON b.monk_id = m.id
      LEFT JOIN rooms r ON r.id = b.room_id
      ${where}
      ORDER BY CASE m.status WHEN 'permanent' THEN 0 WHEN 'inspection' THEN 1
                              WHEN 'guadan' THEN 2 ELSE 3 END,
               m.created_at DESC
    `, params);
  });

  // 新增僧人（挂单登记时若尚未建档）
  app.post('/', async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!body.dharma_name || String(body.dharma_name).trim() === '') {
      throw new ApiError(400, '法名不能为空');
    }
    const row = await one(`
      INSERT INTO monks (dharma_name, home_monastery, ordination_no, status, note)
      VALUES ($1, $2, $3, COALESCE($4::monk_status, 'guadan'), $5)
      RETURNING *
    `, [
      String(body.dharma_name).trim(),
      body.home_monastery ?? null,
      body.ordination_no ?? null,
      body.status ?? null,
      body.note ?? null,
    ]);
    return reply.code(201).send(row);
  });

  // 僧人详情（含最近挂单、进行中考察）
  app.get<{ Params: { id: string } }>('/:id', async (req) => {
    const monk = await one(`
      SELECT m.*, r.room_no, b.bed_no
      FROM monks m
      LEFT JOIN beds b ON b.monk_id = m.id
      LEFT JOIN rooms r ON r.id = b.room_id
      WHERE m.id = $1
    `, [req.params.id]);
    if (!monk) throw new ApiError(404, '僧人不存在');

    const guadanList = await many(`
      SELECT g.*, r.room_no, b.bed_no
      FROM guadan g
      LEFT JOIN beds b ON b.id = g.bed_id
      LEFT JOIN rooms r ON r.id = b.room_id
      WHERE g.monk_id = $1
      ORDER BY g.arrive_date DESC
    `, [req.params.id]);

    const inspection = await one(`
      SELECT * FROM inspections
      WHERE monk_id = $1 AND result = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `, [req.params.id]);

    const recentAttendance = await many(`
      SELECT * FROM attendance
      WHERE monk_id = $1 AND attend_date >= CURRENT_DATE - 29
      ORDER BY attend_date DESC, session
    `, [req.params.id]);

    const absentCount = recentAttendance.filter((a) => a.status === 'absent').length;

    return { ...monk, guadan_list: guadanList, inspection, recent_attendance: recentAttendance, absent_count_30d: absentCount };
  });

  // 编辑僧人档案
  app.put<{ Params: { id: string } }>('/:id', async (req) => {
    const body = req.body as Record<string, unknown>;
    const fields = [
      'dharma_name', 'home_monastery', 'ordination_no', 'generation', 'tonsure_master',
      'ordination_date', 'ordination_place', 'current_post', 'note',
    ];
    const sets: string[] = [];
    const params: unknown[] = [req.params.id];
    for (const f of fields) {
      if (f in body) {
        params.push(body[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (sets.length === 0) throw new ApiError(400, '没有需要更新的字段');
    const row = await one(
      `UPDATE monks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params,
    );
    if (!row) throw new ApiError(404, '僧人不存在');
    return row;
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req) => {
    const result = await one<{ id: string } | null>(
      'DELETE FROM monks WHERE id = $1 RETURNING id',
      [req.params.id],
    );
    if (!result) throw new ApiError(404, '僧人不存在');
    return { ok: true };
  });
};

export default routes;
