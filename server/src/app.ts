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
import ceremoniesRoutes from './routes/ceremonies.js';

export async function buildApp() {
  const app = Fastify({ logger: false });

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
  await app.register(ceremoniesRoutes, { prefix: '/api/ceremonies' });

  app.setErrorHandler((err, _req, reply) => {
    const code = (err as Error & { statusCode?: number }).statusCode;
    reply.code(code ?? 500).send({
      message: err.message || '服务器内部错误',
    });
  });

  return app;
}

export async function closeDb() {
  await pool.end();
}
