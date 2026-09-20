import 'dotenv/config';
import { buildApp } from './app.js';
import { pool } from './db.js';

const app = buildApp();
app.log.level = 'info';

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
