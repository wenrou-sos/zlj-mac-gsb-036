import type { FastifyPluginAsync } from 'fastify';
import { many, one, ApiError, asEnum, ALERT_STATUSES } from '../db.js';

const routes: FastifyPluginAsync = async (app) => {
  // 提醒列表（客堂待办）
  app.get('/', async (req) => {
    const { status } = req.query as { status?: string };
    const conds = ['1=1'];
    const params: unknown[] = [];
    if (status) {
      params.push(asEnum(status, ALERT_STATUSES, '提醒状态'));
      conds.push(`al.status = $${params.length}::alert_status`);
    } else {
      conds.push("al.status = 'open'");
    }
    return many(`
      SELECT al.*, m.dharma_name, m.status AS monk_status, m.current_post,
             r.room_no, b.bed_no
      FROM absence_alerts al
      JOIN monks m ON m.id = al.monk_id
      LEFT JOIN beds b ON b.monk_id = m.id
      LEFT JOIN rooms r ON r.id = b.room_id
      WHERE ${conds.join(' AND ')}
      ORDER BY CASE al.status WHEN 'open' THEN 0 ELSE 1 END, al.created_at DESC
    `, params);
  });

  // 待处理提醒数量（角标用）
  app.get('/open-count', async () =>
    one(`SELECT count(*)::int AS n FROM absence_alerts WHERE status='open'`),
  );

  // 知客知悉处理
  app.post<{ Params: { id: string } }>('/:id/ack', async (req) => {
    const { acknowledged_by } = req.body as { acknowledged_by?: string };
    const row = await one(
      `UPDATE absence_alerts SET status='acknowledged', acknowledged_by=$2, acknowledged_at=now()
       WHERE id=$1 AND status='open' RETURNING id`,
      [req.params.id, acknowledged_by ?? '知客'],
    );
    if (!row) throw new ApiError(404, '待处理提醒不存在');
    return { ok: true };
  });
};

export default routes;
