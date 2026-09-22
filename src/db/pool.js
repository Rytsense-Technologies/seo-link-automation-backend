/**
 * PostgreSQL access (app/db/session.py). The pool is created lazily so importing never touches
 * the database. Every driver/connection failure is re-thrown as `DatabaseError` (the equivalent
 * of SQLAlchemyError), which the API maps to 503 DATABASE_ERROR.
 */

import pg from 'pg';
import { getSettings, toPgConnectionString } from '../config/config.js';
import { AppError, DatabaseError } from '../utils/errors.js';

const TIMESTAMPTZ_OID = 1184;

/**
 * Render timestamptz like Python's `datetime.isoformat()` so API timestamps are identical to the
 * reference: "2026-09-22 09:15:56.315505+01" -> "2026-09-22T09:15:56.315505+01:00".
 */
export function isoTimestamp(raw) {
  if (raw === null) return null;
  const m = /^(\d{4,}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?([+-]\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/.exec(raw);
  if (!m) return raw;
  const [, date, time, frac = '', hh, mm = '00', ss] = m;
  const micros = frac ? `.${frac.slice(1).padEnd(6, '0').slice(0, 6)}` : '';
  return `${date}T${time}${micros}${hh}:${mm}${ss ? `:${ss}` : ''}`;
}

pg.types.setTypeParser(TIMESTAMPTZ_OID, isoTimestamp);

let pool = null;

export function getPool() {
  if (pool === null) {
    const settings = getSettings();
    pool = new pg.Pool({
      connectionString: toPgConnectionString(settings.database_url),
      max: settings.database_pool_size,
    });
    pool.on('error', () => {
      /* idle client errors are surfaced on the next query */
    });
  }
  return pool;
}

export function createPool(connectionString, max = 5) {
  const p = new pg.Pool({ connectionString: toPgConnectionString(connectionString), max });
  p.on('error', () => {});
  return p;
}

export async function closePool() {
  if (pool !== null) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

export function wrapDbError(err) {
  if (err instanceof AppError || err instanceof DatabaseError) return err;
  return new DatabaseError(err);
}

/** Run a query on a pool or client, converting driver errors to DatabaseError. */
export async function runQuery(executor, text, params = []) {
  try {
    return await executor.query(text, params);
  } catch (err) {
    throw wrapDbError(err);
  }
}

/** Check out a client (wrapping connection failures). */
export async function connect(p = getPool()) {
  try {
    return await p.connect();
  } catch (err) {
    throw wrapDbError(err);
  }
}

/** `BEGIN ... COMMIT` on a dedicated client; ROLLBACK on any error. */
export async function withTransaction(fn, p = getPool()) {
  const client = await connect(p);
  try {
    await runQuery(client, 'BEGIN');
    const result = await fn(client);
    await runQuery(client, 'COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* connection may already be broken */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function pingDatabase(p = getPool()) {
  await runQuery(p, 'SELECT 1');
}
