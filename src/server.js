/** Production entry point: `npm start` (or `npm run dev` with --watch). */

import { buildApp } from './app.js';
import { getSettings } from './config/config.js';
import { closePool } from './db/pool.js';

const settings = getSettings();
const level = settings.log_level.toLowerCase() === 'warning' ? 'warn' : settings.log_level.toLowerCase();
const app = await buildApp({ logger: { level } });

const port = Number(process.env.PORT || 8000);
const host = process.env.HOST || '127.0.0.1';

async function shutdown(signal) {
  app.log.info(`${signal} received, shutting down`);
  await app.close();
  await closePool();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

await app.listen({ port, host });
