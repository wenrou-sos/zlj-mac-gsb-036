import type { FastifyPluginAsync } from 'fastify';
import { pool, many, one, ApiError } from '../db.js';

const routes: FastifyPluginAsync = async (app) => {
  // 寮房与床位一览（含入住统计）
  app.get('/', async () => {
    const rooms = await many(`
      SELECT r.*,
        count(b.*)::int AS bed_count,
        count(b.monk_id)::int AS occupied_count
      FROM rooms r
      LEFT JOIN beds b ON b.room_id = r.id
      GROUP BY r.id
      ORDER BY r.room_no
    `);
    const beds = await many(`
      SELECT b.id, b.room_id, b.bed_no, b.monk_id, m.dharma_name, m.status AS monk_status
      FROM beds b
      LEFT JOIN monks m ON m.id = b.monk_id
      ORDER BY b.bed_no
    `);
    return rooms.map((r) => ({
      ...r,
      beds: beds.filter((b) => b.room_id === r.id),
    }));
  });

  // 空闲床位（挂单安排床位用）
  app.get('/available-beds', async () => many(`
    SELECT b.id, b.bed_no, r.id AS room_id, r.room_no
    FROM beds b JOIN rooms r ON r.id = b.room_id
    WHERE b.monk_id IS NULL
    ORDER BY r.room_no, b.bed_no
  `));

  app.post('/', async (req, reply) => {
    const { room_no, capacity, note } = req.body as {
      room_no?: string; capacity?: number; note?: string | null;
    };
    if (!room_no?.trim()) throw new ApiError(400, '房间号不能为空');
    if (!capacity || capacity <= 0) throw new ApiError(400, '床位数必须为正整数');

    // 事务：建房间并生成床位
    const pg = await pool.connect();
    try {
      await pg.query('BEGIN');
      const exists = await pg.query('SELECT 1 FROM rooms WHERE room_no=$1', [room_no.trim()]);
      if (exists.rowCount) throw new ApiError(409, '房间号已存在');
      const { rows } = await pg.query(
        'INSERT INTO rooms (room_no, capacity, note) VALUES ($1,$2,$3) RETURNING *',
        [room_no.trim(), capacity, note ?? null],
      );
      const roomId = rows[0].id as string;
      for (let i = 1; i <= capacity; i++) {
        await pg.query('INSERT INTO beds (room_id, bed_no) VALUES ($1, $2)', [roomId, String(i)]);
      }
      await pg.query('COMMIT');
      return reply.code(201).send(rows[0]);
    } catch (e) {
      await pg.query('ROLLBACK');
      throw e;
    } finally {
      pg.release();
    }
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req) => {
    const occupied = await one<{ n: number }>(
      'SELECT count(*)::int AS n FROM beds WHERE room_id=$1 AND monk_id IS NOT NULL',
      [req.params.id],
    );
    if (occupied.n > 0) throw new ApiError(409, '该寮房仍有僧人入住，无法删除');
    const result = await one('DELETE FROM rooms WHERE id=$1 RETURNING id', [req.params.id]);
    if (!result) throw new ApiError(404, '寮房不存在');
    return { ok: true };
  });
};

export default routes;
