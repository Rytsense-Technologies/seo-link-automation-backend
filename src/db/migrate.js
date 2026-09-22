/**
 * Schema management compatible with the Python/Alembic reference (revision 20260922_0001).
 *
 * - Never alters or resets an existing database.
 * - On an EMPTY database, applies the exact DDL rendered from the Alembic migration and records
 *   `alembic_version = 20260922_0001`, so Alembic and Node agree on the schema state.
 * - `npm run db:migrate` is a no-op when the database is already at head.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEAD_REVISION = '20260922_0001';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const readSql = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');

export async function currentRevision(executor) {
  const { rows } = await executor.query("SELECT to_regclass('public.alembic_version') AS t");
  if (!rows[0].t) return null;
  const { rows: v } = await executor.query('SELECT version_num FROM alembic_version');
  return v[0]?.version_num ?? null;
}

async function hasAppTables(executor) {
  const { rows } = await executor.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('sites','pages','internal_link_suggestions')",
  );
  return rows[0].n > 0;
}

/** Bring an empty database to head; no-op at head; refuse anything else. */
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    const revision = await currentRevision(client);
    if (revision === HEAD_REVISION) return 'already at head';
    if (revision !== null || (await hasAppTables(client))) {
      throw new Error(`Database is at unexpected revision ${revision ?? '(untracked tables)'}; refusing to modify it`);
    }
    await client.query('BEGIN');
    try {
      if (!(await client.query("SELECT to_regclass('public.alembic_version') AS t")).rows[0].t) {
        await client.query(readSql('20260922_0001_initial.up.sql'));
      } else {
        await client.query(readSql('20260922_0001_initial.up.sql').replace(/CREATE TABLE alembic_version[\s\S]*?\);/, ''));
      }
      await client.query('INSERT INTO alembic_version (version_num) VALUES ($1)', [HEAD_REVISION]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    return `migrated to ${HEAD_REVISION}`;
  } finally {
    client.release();
  }
}

/** Drop the schema (test databases only; used by the integration suite). */
export async function downgradeToBase(pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (await currentRevision(client)) {
      await client.query(readSql('20260922_0001_initial.down.sql'));
      await client.query('DELETE FROM alembic_version');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { getPool, closePool } = await import('./pool.js');
  try {
    console.log(await migrate(getPool()));
  } finally {
    await closePool();
  }
}
