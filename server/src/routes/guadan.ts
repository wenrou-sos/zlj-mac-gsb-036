import type { FastifyPluginAsync } from 'fastify';
import { pool, many, one, ApiError, asEnum, GUADAN_STATUSES } from '../db.js';

interface GuadanBody {
  dharma_name?: string;
  home_monastery?: string | null;
  ordination_no?: string | null;
  arrive_date?: string;
  expected_days?: number;
  bed_id?: string | null;
  note?: string | null;
  monk_id?: string; // 已建档僧人再次来寺
}

const routes: FastifyPluginAsync = async (app) => {
  // 挂单列表
  app.get('/', async (req) => {
    const { status, q } = req.query as { status?: string; q?: string };
    const conds: string[] = [];
    const params: unknown[] = [];
    if (status) {
      params.push(asEnum(status, GUADAN_STATUSES, '挂单状态'));
      conds.push(`g.status = $${params.length}::guadan_status`);
    } else {
      conds.push(`g.status = 'active'`);
    }
    if (q?.trim()) {
      params.push(`%${q.trim()}%`);
      conds.push(`(m.dharma_name ILIKE $${params.length} OR m.ordination_no ILIKE $${params.length})`);
    }
    const where = `WHERE ${conds.join(' AND ')}`;
    return many(`
      SELECT g.*, m.dharma_name, m.home_monastery, m.ordination_no, m.status AS monk_status,
             r.room_no, b.bed_no,
             (g.arrive_date + (g.expected_days * INTERVAL '1 day'))::date AS expected_leave
      FROM guadan g
      JOIN monks m ON m.id = g.monk_id
      LEFT JOIN beds b ON b.id = g.bed_id
      LEFT JOIN rooms r ON r.id = b.room_id
      ${where}
      ORDER BY g.arrive_date DESC
    `, params);
  });

  // 挂单登记（新僧人一并建档）；可同时安排床位，事务内校验床位空闲
  app.post('/', async (req, reply) => {
    const body = req.body as GuadanBody;
    if (!body.dharma_name?.trim()) throw new ApiError(400, '法名不能为空');
    if (!body.arrive_date) throw new ApiError(400, '到寺日期不能为空');
    if (!body.expected_days || body.expected_days <= 0) throw new ApiError(400, '预计住几天必须为正整数');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      let monkId = body.monk_id;
      if (!monkId) {
        const { rows } = await client.query(
          `INSERT INTO monks (dharma_name, home_monastery, ordination_no, status, note)
           VALUES ($1, $2, $3, 'guadan', NULL) RETURNING id`,
          [body.dharma_name.trim(), body.home_monastery ?? null, body.ordination_no ?? null],
        );
        monkId = rows[0].id as string;
      } else {
        await client.query(
          `UPDATE monks SET status='guadan', home_monastery=COALESCE($2, home_monastery),
             ordination_no=COALESCE($3, ordination_no) WHERE id=$1`,
          [monkId, body.home_monastery ?? null, body.ordination_no ?? null],
        );
      }

      if (body.bed_id) {
        const { rows: beds } = await client.query(
          'SELECT monk_id FROM beds WHERE id=$1 FOR UPDATE',
          [body.bed_id],
        );
        if (beds.length === 0) throw new ApiError(400, '所选床位不存在');
        if (beds[0].monk_id) throw new ApiError(409, '该床位已有人入住');
      }

      const { rows } = await client.query(
        `INSERT INTO guadan (monk_id, arrive_date, expected_days, bed_id, note)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [monkId, body.arrive_date, body.expected_days, body.bed_id ?? null, body.note ?? null],
      );

      if (body.bed_id) {
        await client.query('UPDATE beds SET monk_id=$1 WHERE id=$2', [monkId, body.bed_id]);
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

  // 安排/调换床位
  app.put<{ Params: { id: string } }>('/:id/bed', async (req) => {
    const { bed_id } = req.body as { bed_id: string };
    const g = await one<{ bed_id: string | null; monk_id: string } | null>(
      'SELECT bed_id, monk_id FROM guadan WHERE id=$1 AND status=\'active\'',
      [req.params.id],
    );
    if (!g) throw new ApiError(404, '有效挂单记录不存在');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT monk_id FROM beds WHERE id=$1 FOR UPDATE', [bed_id]);
      if (rows.length === 0) throw new ApiError(400, '床位不存在');
      if (rows[0].monk_id && rows[0].monk_id !== g.monk_id) throw new ApiError(409, '该床位已有人入住');

      if (g.bed_id) await client.query('UPDATE beds SET monk_id=NULL WHERE id=$1', [g.bed_id]);
      await client.query('UPDATE beds SET monk_id=$1 WHERE id=$2', [g.monk_id, bed_id]);
      await client.query('UPDATE guadan SET bed_id=$1 WHERE id=$2', [bed_id, req.params.id]);
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // 续单（调整预计天数）
  app.put<{ Params: { id: string } }>('/:id/extend', async (req) => {
    const { days } = req.body as { days: number };
    if (!days || days <= 0) throw new ApiError(400, '续住天数必须为正整数');
    const row = await one(
      `UPDATE guadan SET expected_days = expected_days + $2
       WHERE id=$1 AND status='active' RETURNING *`,
      [req.params.id, days],
    );
    if (!row) throw new ApiError(404, '有效挂单记录不存在');
    return row;
  });

  // 舍单离寺：释放床位，关闭挂单，僧人状态置 left
  app.post<{ Params: { id: string } }>('/:id/checkout', async (req) => {
    const { leave_date, note } = req.body as { leave_date?: string; note?: string };
    const g = await one<{ monk_id: string; bed_id: string | null } | null>(
      'SELECT monk_id, bed_id FROM guadan WHERE id=$1 AND status=\'active\'',
      [req.params.id],
    );
    if (!g) throw new ApiError(404, '有效挂单记录不存在');

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE guadan SET status='closed', leave_date=$2, note=COALESCE($3, note)
         WHERE id=$1`,
        [req.params.id, leave_date ?? new Date().toISOString().slice(0, 10), note ?? null],
      );
      if (g.bed_id) await client.query('UPDATE beds SET monk_id=NULL WHERE id=$1', [g.bed_id]);
      // 若没有其他在寺挂单/考察，则置离寺
      const { rows } = await client.query(
        `SELECT 1 FROM guadan WHERE monk_id=$1 AND status='active' AND id <> $2 LIMIT 1`,
        [g.monk_id, req.params.id],
      );
      if (rows.length === 0) await client.query('UPDATE monks SET status=\'left\' WHERE id=$1', [g.monk_id]);
      await client.query('COMMIT');
      return { ok: true };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
};

export default routes;
