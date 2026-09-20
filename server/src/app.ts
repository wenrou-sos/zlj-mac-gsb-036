import Fastify from 'fastify';
import cors from '@fastify/cors';
import monksRoutes from './routes/monks.js';
import guadanRoutes from './routes/guadan.js';
import roomsRoutes from './routes/rooms.js';
import inspectionsRoutes from './routes/inspections.js';
import reviewsRoutes from './routes/reviews.js';
import attendanceRoutes from './routes/attendance.js';
import alertsRoutes from './routes/alerts.js';
import dashboardRoutes from './routes/dashboard.js';
import ceremoniesRoutes from './routes/ceremonies.js';

export function buildApp() {
  const app = Fastify({ logger: false });

  app.register(cors, { origin: true });

  app.get('/api/health', async () => ({ ok: true }));

  app.register(monksRoutes, { prefix: '/api/monks' });
  app.register(guadanRoutes, { prefix: '/api/guadan' });
  app.register(roomsRoutes, { prefix: '/api/rooms' });
  app.register(inspectionsRoutes, { prefix: '/api/inspections' });
  app.register(reviewsRoutes, { prefix: '/api/reviews' });
  app.register(attendanceRoutes, { prefix: '/api/attendance' });
  app.register(alertsRoutes, { prefix: '/api/alerts' });
  app.register(dashboardRoutes, { prefix: '/api/dashboard' });
  app.register(ceremoniesRoutes, { prefix: '/api/ceremonies' });

  app.setErrorHandler((err, _req, reply) => {
    app.log.error(err);
    const code = (err as Error & { statusCode?: number }).statusCode;
    reply.code(code ?? 500).send({
      message: err.message || '服务器内部错误',
    });
  });

  return app;
}
