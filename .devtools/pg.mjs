// 开发辅助：在用户态启动免安装的 PostgreSQL（无 root / docker 时使用）
// 用法：node pg.mjs（保持运行，Ctrl+C 停止）
import EmbeddedPostgres from 'embedded-postgres';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const pgServer = new EmbeddedPostgres({
  databaseDir: join(__dirname, 'pgdata'),
  user: 'postgres',
  password: 'postgres',
  port: 5432,
  persistent: true,
});

await pgServer.initialise();
await pgServer.start();
console.log('[devpg] PostgreSQL 已启动于 127.0.0.1:5432');

// 首次初始化：建库 -> 建表 -> 种子数据
const admin = pgServer.getPgClient('postgres');
await admin.connect();
const { rows: dbs } = await admin.query("SELECT 1 FROM pg_database WHERE datname='sangha'");
if (dbs.length === 0) {
  await admin.query('CREATE DATABASE sangha');
  console.log('[devpg] 数据库 sangha 已创建');
}
await admin.end();

const client = new pg.Client({
  host: '127.0.0.1',
  port: 5432,
  user: 'postgres',
  password: 'postgres',
  database: 'sangha',
});
await client.connect();
const { rows } = await client.query(`SELECT to_regclass('public.monks') AS t`);
if (!rows[0].t) {
  console.log('[devpg] 首次启动，执行建表与种子脚本...');
  await client.query(readFileSync(join(ROOT, 'db/init/01_schema.sql'), 'utf8'));
  await client.query(readFileSync(join(ROOT, 'db/init/02_seed.sql'), 'utf8'));
  console.log('[devpg] 初始化完成');
} else {
  console.log('[devpg] 数据目录已存在，跳过初始化');
}
await client.end();

const stop = async () => {
  await pgServer.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
