/**
 * The Vercel function contract: a default-exported request handler that drives the existing
 * Fastify app. Mounted on a real http.Server here, which is how Vercel's Node runtime invokes it.
 * Only routes that need no database are exercised (the pool stays lazy).
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import handler, { getApp } from '../../api/index.js';

let baseUrl;
let server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  const app = await getApp();
  await app.close();
});

describe('vercel handler', () => {
  it('is a default-exported function (what Vercel requires)', () => {
    expect(typeof handler).toBe('function');
    expect(handler.length).toBe(2); // (request, response)
  });

  it('serves a Fastify route through the handler', async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('reuses one Fastify instance across requests (warm container)', async () => {
    const [first, second] = [await getApp(), await getApp()];
    expect(first).toBe(second);
    expect(first.server.listening).toBe(false); // app.listen() is never called in the function
  });

  it('keeps the error envelope for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: { code: 'HTTP_ERROR', message: 'Not Found', details: null } });
  });

  it('keeps method handling (405 for a known path)', async () => {
    const response = await fetch(`${baseUrl}/health`, { method: 'DELETE' });
    expect(response.status).toBe(405);
    expect((await response.json()).error.code).toBe('HTTP_ERROR');
  });

  it('passes request bodies through to Fastify', async () => {
    // Malformed JSON is rejected by the app's own parser, which proves the body reached it.
    const response = await fetch(`${baseUrl}/api/interlink/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('keeps the documented API surface reachable', async () => {
    const spec = await (await fetch(`${baseUrl}/openapi.json`)).json();
    for (const path of ['/api/sites', '/api/interlink/suggestions', '/api/interlink/suggestions/{suggestion_id}/apply']) {
      expect(Object.keys(spec.paths)).toContain(path);
    }
    expect((await fetch(`${baseUrl}/docs`)).status).toBe(200);
  });
});
