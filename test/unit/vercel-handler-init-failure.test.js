/**
 * What the Vercel function does when the app cannot be built at all - the failure mode that
 * produced SERVER_INITIALISATION_FAILED in production when the deployment shipped without
 * @fastify/swagger-ui's static assets. The reason must reach the platform log, never the client.
 */
import http from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const SECRET = 'postgresql://neon_user:SuperSecret123@ep-x.aws.neon.tech/neondb';

vi.mock('../../src/app.js', () => ({
  buildApp: vi.fn(async () => {
    throw new Error(`Cannot find module './static/csp.json' while connecting to ${SECRET}`);
  }),
}));

const { default: handler } = await import('../../api/index.js');
const { buildApp } = await import('../../src/app.js');

let baseUrl;
let server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('vercel handler: initialisation failure', () => {
  it('answers with the standard error envelope and no internal detail', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: { code: 'SERVER_INITIALISATION_FAILED', message: 'The server could not start', details: null },
    });
    // The client is told nothing about the cause, and nothing secret is echoed.
    expect(body).not.toContain('csp.json');
    expect(body).not.toContain('SuperSecret123');
    expect(body).not.toContain('neon');

    // The platform log carries the reason, so the deployment can be diagnosed.
    const logged = spy.mock.calls.flat().join('\n');
    expect(logged).toContain('Server initialisation failed');
    expect(logged).toContain("Cannot find module './static/csp.json'");
  });

  it('retries the build on the next request instead of caching the failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const before = buildApp.mock.calls.length;
    await fetch(`${baseUrl}/health`);
    await fetch(`${baseUrl}/health`);
    expect(buildApp.mock.calls.length).toBe(before + 2);
  });
});
