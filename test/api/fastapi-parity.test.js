// HTTP-level behaviour that must match FastAPI/Starlette in the Python reference. Expected bodies were
// recorded from the Python server (uvicorn app.main:app) for the same requests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';
import { NotFoundError } from '../../src/utils/errors.js';
import { FakeInterlinkRepository, buildService, cleanSettings } from '../helpers/fakes.js';

const Z = '00000000-0000-0000-0000-000000000000';
const BAD_UUID = { type: 'uuid_parsing', msg: 'Input should be a valid UUID, invalid length: expected length 32 for simple format, found 3', input: 'bad', ctx: { error: 'invalid length: expected length 32 for simple format, found 3' } };
const validation = (errors) => ({ error: { code: 'VALIDATION_ERROR', message: 'Request validation failed', details: { errors } } });

let app;
beforeAll(async () => {
  const pages = {
    getSite: async () => {
      throw new NotFoundError('Site not found', { code: 'SITE_NOT_FOUND' });
    },
    listPages: async ({ page, pageSize }) => [[], 0, page, pageSize],
    getPage: async () => {
      throw new NotFoundError('Page not found', { code: 'PAGE_NOT_FOUND' });
    },
  };
  app = await buildApp({
    settings: cleanSettings(),
    deps: {
      pageService: () => pages,
      interlinkService: async () => ({ service: buildService(new FakeInterlinkRepository([])), close: async () => {} }),
      siteCrawler: () => ({ crawler: { crawl: async () => ({}) }, close: async () => {} }),
    },
  });
});
afterAll(() => app.close());

const send = (method, url, { body, contentType = 'application/json', headers = {} } = {}) =>
  app.inject({
    method,
    url,
    headers: { ...(body !== undefined && contentType ? { 'content-type': contentType } : {}), ...headers },
    ...(body !== undefined ? { payload: body } : {}),
  });

describe('routing (Starlette)', () => {
  it('redirects a trailing slash with an absolute Location, keeping the query', async () => {
    const res = await send('GET', '/api/pages/?page=2', { headers: { host: 'api.test:8000' } });
    expect(res.statusCode).toBe(307);
    expect(res.headers.location).toBe('http://api.test:8000/api/pages?page=2');
  });

  it('an empty path parameter does not match the parameterised route', async () => {
    expect((await send('GET', '/api/interlink/suggestions/')).statusCode).toBe(307);
    expect((await send('POST', '/api/interlink/suggestions//approve')).statusCode).toBe(404);
  });

  it('405 without an Allow header; JSON content-type without charset', async () => {
    const res = await send('DELETE', '/api/pages');
    expect(res.statusCode).toBe(405);
    expect(res.headers.allow).toBeUndefined();
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.json()).toEqual({ error: { code: 'HTTP_ERROR', message: 'Method Not Allowed', details: null } });
  });
});

describe('request validation (FastAPI + Pydantic)', () => {
  it('reports path, query and body errors together in FastAPI order', async () => {
    let res = await send('POST', '/api/interlink/suggestions/bad/reject', { body: '{"reason":5}' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual(
      validation([
        { ...BAD_UUID, loc: ['path', 'suggestion_id'] },
        { type: 'string_type', loc: ['body', 'reason'], msg: 'Input should be a valid string', input: 5 },
      ]),
    );
    res = await send('GET', '/api/interlink/suggestions?status=&page=0&site_id=&min_relevance_score=abc');
    expect(res.json()).toEqual(
      validation([
        { type: 'enum', loc: ['query', 'status'], msg: "Input should be 'PENDING', 'APPROVED', 'REJECTED' or 'APPLIED'", input: '', ctx: { expected: "'PENDING', 'APPROVED', 'REJECTED' or 'APPLIED'" } },
        { type: 'uuid_parsing', loc: ['query', 'site_id'], msg: 'Input should be a valid UUID, invalid length: expected length 32 for simple format, found 0', input: '', ctx: { error: 'invalid length: expected length 32 for simple format, found 0' } },
        { type: 'int_parsing', loc: ['query', 'min_relevance_score'], msg: 'Input should be a valid integer, unable to parse string as an integer', input: 'abc' },
        { type: 'greater_than_equal', loc: ['query', 'page'], msg: 'Input should be greater than or equal to 1', input: '0', ctx: { ge: 1 } },
      ]),
    );
  });

  it('does not coerce like Ajv: numbers are not strings, scalars are not lists', async () => {
    const res = await send('PUT', `/api/sites/${Z}/pages`, {
      body: JSON.stringify({ pages: [5, { url: '' }, { url: '/x', keywords: 'a', http_status: '99', is_indexable: 'maybe', last_crawled_at: '2026-99-01' }] }),
    });
    expect(res.json()).toEqual(
      validation([
        { type: 'model_attributes_type', loc: ['body', 'pages', 0], msg: 'Input should be a valid dictionary or object to extract fields from', input: 5 },
        { type: 'string_too_short', loc: ['body', 'pages', 1, 'url'], msg: 'String should have at least 1 character', input: '', ctx: { min_length: 1 } },
        { type: 'greater_than_equal', loc: ['body', 'pages', 2, 'http_status'], msg: 'Input should be greater than or equal to 100', input: '99', ctx: { ge: 100 } },
        { type: 'bool_parsing', loc: ['body', 'pages', 2, 'is_indexable'], msg: 'Input should be a valid boolean, unable to interpret input', input: 'maybe' },
        { type: 'list_type', loc: ['body', 'pages', 2, 'keywords'], msg: 'Input should be a valid list', input: 'a' },
        { type: 'datetime_from_date_parsing', loc: ['body', 'pages', 2, 'last_crawled_at'], msg: 'Input should be a valid datetime or date, month value is outside expected range of 1-12', input: '2026-99-01', ctx: { error: 'month value is outside expected range of 1-12' } },
      ]),
    );
  });

  it('accepts what Pydantic accepts (lax strings, braced UUIDs)', async () => {
    const res = await send('POST', '/api/interlink/analyze', { body: `{"source_page_id":"{${Z}}","dry_run":"yes","max_suggestions":"3","min_relevance_score":true}` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PAGE_NOT_FOUND');
    expect((await send('GET', '/api/pages?page=1_0&page_size=+5')).statusCode).toBe(200);
  });

  it('missing fields echo the raw body; optional bodies default', async () => {
    let res = await send('POST', '/api/sites', { body: '{"base_url":5}' });
    expect(res.json()).toEqual(
      validation([
        { type: 'missing', loc: ['body', 'name'], msg: 'Field required', input: { base_url: 5 } },
        { type: 'url_type', loc: ['body', 'base_url'], msg: 'URL input should be a string or URL', input: 5 },
      ]),
    );
    res = await send('POST', '/api/interlink/analyze', { body: 'null' });
    expect(res.json()).toEqual(validation([{ type: 'missing', loc: ['body'], msg: 'Field required', input: null }]));
    expect((await send('POST', `/api/sites/${Z}/crawl`, { body: 'null' })).json().error.code).toBe('SITE_NOT_FOUND');
    expect((await send('POST', `/api/interlink/suggestions/${Z}/reject`, { body: 'null' })).json().error.code).toBe('SUGGESTION_NOT_FOUND');
  });
});

describe('request bodies (Starlette request.json())', () => {
  it('invalid JSON reports Python json position and message', async () => {
    const res = await send('POST', '/api/interlink/analyze', { body: '{bad' });
    expect(res.json()).toEqual(
      validation([{ type: 'json_invalid', loc: ['body', 1], msg: 'JSON decode error', input: {}, ctx: { error: 'Expecting property name enclosed in double quotes' } }]),
    );
  });

  it('undecodable bytes -> 400; UTF-8 BOM and UTF-16 are decoded', async () => {
    let res = await send('POST', '/api/interlink/analyze', { body: Buffer.from([0x7b, 0x22, 0xe9, 0x22, 0x7d]) });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: { code: 'HTTP_ERROR', message: 'There was an error parsing the body', details: null } });
    for (const body of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"source_page_id":"x"}')]), Buffer.from('{"source_page_id":"x"}', 'utf16le')]) {
      res = await send('POST', '/api/interlink/analyze', { body });
      // Decoded and parsed: validation reaches the field.
      expect(res.json().error.details.errors[0].loc).toEqual(['body', 'source_page_id']);
    }
  });

  it('non-JSON or missing content-type leaves the raw body (strict_content_type)', async () => {
    const expected = validation([{ type: 'model_attributes_type', loc: ['body'], msg: 'Input should be a valid dictionary or object to extract fields from', input: '{"source_page_id":"x"}' }]);
    for (const contentType of ['text/plain', 'application/json/x', null]) {
      const res = await send('POST', '/api/interlink/analyze', { body: '{"source_page_id":"x"}', contentType });
      expect(res.statusCode, String(contentType)).toBe(422);
      expect(res.json()).toEqual(expected);
    }
    const res = await send('POST', '/api/interlink/analyze', { body: '{"source_page_id":"x"}', contentType: 'application/vnd.api+json' });
    expect(res.json().error.details.errors[0].type).toBe('uuid_parsing');
  });
});
