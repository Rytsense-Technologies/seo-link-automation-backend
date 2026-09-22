/**
 * Shared setup for the PostgreSQL integration suite (tests/integration/test_postgres.py fixtures).
 *
 * Uses a *dedicated, disposable* database (it is migrated up and down):
 *   TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/link_automation_test npm run test:integration
 * Only TEST_DATABASE_URL is read from .env (dotenv.parse, nothing leaks into process.env).
 */

import fs from 'node:fs';
import dotenv from 'dotenv';
import { createPool } from '../../src/db/pool.js';
import { downgradeToBase, migrate } from '../../src/db/migrate.js';
import { PageService } from '../../src/db/queries/pages.js';
import { SOURCE_HTML } from '../helpers/fakes.js';

function readDbUrl() {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  try {
    return dotenv.parse(fs.readFileSync('.env')).TEST_DATABASE_URL ?? null;
  } catch {
    return null;
  }
}

export const DB_URL = readDbUrl();

/** Refuse to run against a database whose name does not look disposable. */
export function assertDisposable(url) {
  const name = new URL(url.replace(/^postgresql\+\w+:/, 'postgresql:')).pathname.slice(1);
  if (!/test/i.test(name)) throw new Error(`Refusing to migrate up/down non-test database "${name}"`);
}

export async function openTestDatabase() {
  assertDisposable(DB_URL);
  const pool = createPool(DB_URL, 5);
  await downgradeToBase(pool);
  await migrate(pool);
  return pool;
}

export async function closeTestDatabase(pool) {
  await downgradeToBase(pool);
  await pool.end();
}

export async function truncate(pool) {
  await pool.query('TRUNCATE internal_link_suggestions, pages, sites CASCADE');
}

/** The Python `_seed` fixture. */
export async function seed(pool) {
  const service = new PageService(pool);
  const site = await service.createSite({ name: 'Example', base_url: 'https://www.example.com', default_language: 'en' });
  const pages = [
    {
      url: '/customer-support-automation/',
      title: 'Customer Support Automation',
      h1: 'Customer Support Automation',
      keywords: ['customer support automation', 'voice agents'],
      content_html: SOURCE_HTML,
    },
    {
      url: '/ai-voice-agent/',
      title: 'AI Voice Agent for Customer Support',
      h1: 'AI Voice Agents',
      keywords: ['ai voice agent'],
      content_html: '<p>Our AI voice agents answer calls.</p>',
    },
    { url: '/chatbots/', title: 'Chatbot platform' },
    { url: '/old/', title: 'AI voice agents old', http_status: 404 },
    { url: '/beta/', title: 'AI voice agents beta', has_noindex: true },
  ];
  const ids = await service.upsertPages(site.id, pages);
  return [site.id, Object.fromEntries(pages.map((p, i) => [p.url, ids[i]]))];
}

export async function getPageRow(pool, id) {
  const { rows } = await pool.query('SELECT * FROM pages WHERE id = $1', [id]);
  return rows[0] ?? null;
}
