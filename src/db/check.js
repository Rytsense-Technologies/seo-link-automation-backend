/**
 * Database connectivity check (`npm run db:check`), reusing the shared pool.
 *
 * Useful after pointing DATABASE_URL at a new host (e.g. Neon) and in deployment logs: it reports
 * the host and database name only. The user, password and query string are never printed.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, toPgConnectionString } from '../config/config.js';
import { runQuery } from './pool.js';

/** "host:port/database" for logs; contains no credentials. */
export function describeTarget(databaseUrl) {
  try {
    const url = new URL(toPgConnectionString(databaseUrl));
    return `${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {
    return '(unparsable DATABASE_URL)';
  }
}

/** One round trip: proves the connection, TLS and credentials all work. */
export async function checkDatabase(pool) {
  const { rows } = await runQuery(pool, 'SELECT now() AS now, current_database() AS database, current_user AS user');
  const { rows: schema } = await runQuery(
    pool,
    `SELECT count(*)::int AS tables FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('sites', 'pages', 'internal_link_suggestions')`,
  );
  return { ...rows[0], app_tables: schema[0].tables };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { getPool, closePool } = await import('./pool.js');
  const target = describeTarget(getSettings().database_url);
  try {
    const result = await checkDatabase(getPool());
    console.log(`Database connection ok: ${target}`);
    console.log(`  server time : ${result.now}`);
    console.log(`  database    : ${result.database} (user ${result.user})`);
    console.log(`  app tables  : ${result.app_tables}/3 present${result.app_tables === 3 ? '' : ' - run `npm run db:migrate`'}`);
  } catch (error) {
    // Never print the URL: it carries the password.
    console.error(`Database connection failed: ${target}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
