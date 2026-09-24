// PageService.resolvePage against a dedicated, disposable PostgreSQL database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PageService } from '../../src/db/queries/pages.js';
import { NotFoundError, UnprocessableError } from '../../src/utils/errors.js';
import { DB_URL, closeTestDatabase, openTestDatabase, seed, truncate } from './db.js';

describe.skipIf(!DB_URL)('PageService.resolvePage (PostgreSQL)', () => {
  let pool;
  let service;
  let siteId;
  let ids;

  beforeAll(async () => {
    pool = await openTestDatabase();
    service = new PageService(pool);
  });
  afterAll(async () => {
    await closeTestDatabase(pool);
  });
  beforeEach(async () => {
    await truncate(pool);
    [siteId, ids] = await seed(pool); // site https://www.example.com
  });

  const expectCode = async (promise, ErrorClass, code) => {
    const error = await promise.catch((e) => e);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error.code).toBe(code);
  };

  it('finds a page by its exact stored URL, with its site and without content', async () => {
    const { site, page } = await service.resolvePage('https://www.example.com/ai-voice-agent/');
    expect(page.id).toBe(ids['/ai-voice-agent/']);
    expect(page.title).toBe('AI Voice Agent for Customer Support');
    expect(page).not.toHaveProperty('content_html');
    expect(site.id).toBe(siteId);
    expect(site.name).toBe('Example');
  });

  it.each([
    'https://www.example.com/ai-voice-agent', // no trailing slash
    'https://example.com/ai-voice-agent/', // no www.
    'http://www.example.com/ai-voice-agent/', // other scheme
    'HTTPS://WWW.EXAMPLE.COM/ai-voice-agent/#faq', // case + fragment
    '  https://www.example.com/ai-voice-agent/?utm_source=newsletter&gclid=abc  ', // whitespace + tracking
  ])('treats %s as the same page', async (url) => {
    const { page } = await service.resolvePage(url);
    expect(page.id).toBe(ids['/ai-voice-agent/']);
  });

  it('honours an explicit site_id', async () => {
    const { page } = await service.resolvePage('https://www.example.com/chatbots/', { siteId });
    expect(page.id).toBe(ids['/chatbots/']);
  });

  it('reports a page that has not been crawled', async () => {
    await expectCode(service.resolvePage('https://www.example.com/not-crawled/'), NotFoundError, 'PAGE_NOT_FOUND');
  });

  it('reports a URL on a host no site uses', async () => {
    await expectCode(service.resolvePage('https://other.test/ai-voice-agent/'), NotFoundError, 'SITE_NOT_FOUND');
  });

  it('rejects a URL that is not on the given site', async () => {
    await expectCode(
      service.resolvePage('https://other.test/ai-voice-agent/', { siteId }),
      UnprocessableError,
      'INVALID_PAGE_URL',
    );
  });

  it('rejects input that is not an absolute http(s) URL', async () => {
    for (const bad of ['www.example.com/ai-voice-agent/', '/ai-voice-agent/', 'ftp://www.example.com/a']) {
      await expectCode(service.resolvePage(bad), UnprocessableError, 'INVALID_PAGE_URL');
    }
  });

  it('does not modify the page inventory', async () => {
    const before = await pool.query('SELECT id, url, content_version, updated_at FROM pages ORDER BY url');
    await service.resolvePage('https://example.com/ai-voice-agent');
    const after = await pool.query('SELECT id, url, content_version, updated_at FROM pages ORDER BY url');
    expect(after.rows).toEqual(before.rows);
  });
});
