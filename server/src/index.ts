import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { pool } from './db.js';
import monksRoutes from './routes/monks.js';
import guadanRoutes from './routes/guadan.js';
import roomsRoutes from './routes/rooms.js';
import inspectionsRoutes from './routes/inspections.js';
import reviewsRoutes from './routes/reviews.js';
import attendanceRoutes from './routes/attendance.js';
import alertsRoutes from './routes/alerts.js';
import dashboardRoutes from './routes/dashboard.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

app.get('/api/health', async () => ({ ok: true }));

await app.register(monksRoutes, { prefix: '/api/monks' });
await app.register(guadanRoutes, { prefix: '/api/guadan' });
await app.register(roomsRoutes, { prefix: '/api/rooms' });
await app.register(inspectionsRoutes, { prefix: '/api/inspections' });
await app.register(reviewsRoutes, { prefix: '/api/reviews' });
await app.register(attendanceRoutes, { prefix: '/api/attendance' });
await app.register(alertsRoutes, { prefix: '/api/alerts' });
await app.register(dashboardRoutes, { prefix: '/api/dashboard' });

// 统一错误形态
app.setErrorHandler((err, _req, reply) => {
  app.log.error(err);
  const code = (err as Error & { statusCode?: number }).statusCode;
  reply.code(code ?? 500).send({
    message: err.message || '服务器内部错误',
  });
});

const port = Number(process.env.PORT ?? 3000);

try {
  await pool.query('SELECT 1');
  app.log.info('数据库连接正常');
} catch (e) {
  app.log.error('数据库连接失败，请确认 PostgreSQL 已启动（docker compose up -d db）');
  throw e;
}

await app.listen({ port, host: '0.0.0.0' });
app.log.info(`API 服务运行于 http://localhost:${port}`);
