// Port of tests/unit/test_crawler_html_redirects.py — HTML-level redirects and empty 200 pages.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extractPage, isUnusable } from '../../src/crawler/extract.js';
import { loadHtml } from '../../src/crawler/dom.js';
import {
  META_REFRESH,
  NEXT_REDIRECT,
  detectHtmlRedirect,
  detectMetaRefresh,
  detectNextRedirect,
  isNextErrorShell,
} from '../../src/crawler/html-redirects.js';
import { BASE, MockSite, ROBOTS_ALLOW_ALL, crawlRequest, htmlPage, makeCrawler, makeSite } from '../helpers/crawler-fakes.js';

// The Python suite's static fixture (trimmed copy of the observed live response).
const FIXTURE = fs.readFileSync(new URL('../../tests/fixtures/next_redirect_error_shell.html', import.meta.url), 'utf8');
const PROD_URL = 'https://rytsensetech.com/ai-readiness-assessment/';

/** Minimal Next.js static-export error shell carrying a redirect digest. */
function nextShell(target, { mode = 'replace', code = '307' } = {}) {
  const digest = `6:E{\\"digest\\":\\"NEXT_REDIRECT;${mode};${target};${code};\\"}\\n`;
  return (
    '<!DOCTYPE html><html id="__next_error__"><head><meta charSet="utf-8"/></head><body>' +
    '<script>(self.__next_f=self.__next_f||[]).push([0])</script>' +
    `<script>self.__next_f.push([1,"${digest}"])</script></body></html>`
  );
}

const metaRefresh = (content, body = '') =>
  `<html><head><meta http-equiv="refresh" content="${content}"><title>Moved</title></head><body>${body}</body></html>`;

describe('HTML redirect detection', () => {
  it('detects Next.js redirects with target and status', () => {
    const found = detectNextRedirect(nextShell('/us/ai-readiness-assessment/'));
    expect(found).not.toBeNull();
    expect(found.detected).toBe(true);
    expect(found.target).toBe('/us/ai-readiness-assessment/');
    expect(found.statusCode).toBe(307);
    expect(found.type).toBe(NEXT_REDIRECT);
    expect(found.mode).toBe('replace');
  });

  it.each([
    ['push', '308', 308],
    ['replace', '303', 303],
    ['replace', 'true', 308],
    ['push', 'false', 307],
  ])('variant %s/%s -> %s', (mode, code, status) => {
    const found = detectNextRedirect(nextShell('/somewhere/else/', { mode, code }));
    expect(found.target).toBe('/somewhere/else/');
    expect(found.statusCode).toBe(status);
    expect(found.mode).toBe(mode);
  });

  it('extracts the target dynamically and unescapes it', () => {
    expect(detectNextRedirect(nextShell('\\/pricing\\/?plan=pro\\u0026ref=x')).target).toBe('/pricing/?plan=pro&ref=x');
    expect(detectNextRedirect(nextShell('https://rytsensetech.com/us/ai-readiness-assessment/')).target).toBe(
      'https://rytsensetech.com/us/ai-readiness-assessment/',
    );
  });

  it('detects an unescaped digest JSON too', () => {
    expect(detectNextRedirect('<script>{"digest":"NEXT_REDIRECT;replace;/plain/;307;"}</script>').target).toBe('/plain/');
  });

  it('ignores article text that mentions NEXT_REDIRECT', () => {
    const html = htmlPage('Next.js redirects', '<p>When redirect() runs, Next.js throws NEXT_REDIRECT;replace;/x/;307; internally.</p>');
    expect(detectNextRedirect(html)).toBeNull();
    const page = extractPage(html, `${BASE}/blog/next-redirects/`);
    expect(page.htmlRedirect).toBeNull();
    expect(page.isEmpty).toBe(false);
  });

  it.each([
    ['0;url=/us/example/', '/us/example/', 0.0],
    ['0; URL=/us/example/', '/us/example/', 0.0],
    ["  5 ;  url = '/us/example/' ", '/us/example/', 5.0],
    ["3,url='https://rytsensetech.com/us/example/'", 'https://rytsensetech.com/us/example/', 3.0],
    ['0;/us/example/', '/us/example/', 0.0],
  ])('meta refresh variant %j', (content, target, delay) => {
    const html = metaRefresh(content).replace('http-equiv="refresh"', 'HTTP-EQUIV="Refresh"');
    const found = detectMetaRefresh(loadHtml(html));
    expect(found.type).toBe(META_REFRESH);
    expect(found.target).toBe(target);
    expect(found.delaySeconds).toBe(delay);
  });

  it('ignores meta refresh without a target or inside noscript', () => {
    expect(detectHtmlRedirect(metaRefresh('30'))).toBeNull(); // reload same page
    const noscript = '<html><head><noscript><meta http-equiv="refresh" content="0;url=/nojs/"></noscript></head><body><p>App</p></body></html>';
    expect(detectHtmlRedirect(noscript)).toBeNull();
  });

  it.each(['javascript:alert(1)', 'JavaScript:alert(document.cookie)', 'data:text/html,hi'])('flags unsafe scheme %s', (target) => {
    expect(detectHtmlRedirect(metaRefresh(`0;url=${target}`)).hasUnsafeScheme).toBe(true);
    expect(detectNextRedirect(nextShell('javascript:alert(1)')).hasUnsafeScheme).toBe(true);
  });
});

describe('empty / valid pages', () => {
  it('a normal page is valid and not a redirect', () => {
    const page = extractPage(htmlPage('AI Voice Agent', '<h1>AI Voice Agents</h1><p>We automate calls.</p>'), `${BASE}/ai-voice-agent/`);
    expect(page.htmlRedirect).toBeNull();
    expect(page.isErrorShell).toBe(false);
    expect(page.isEmpty).toBe(false);
  });

  it.each([
    '<html><head><title>T</title></head><body><main><h1>H</h1><p>Body.</p></main></body></html>', // no canonical
    '<html><head><title>T</title></head><body><main><p>Body copy.</p></main></body></html>', // no H1
    '<html><body><main><h1>Heading</h1><p>Body copy.</p></main></body></html>', // no title
    '<html><body><p>Just some useful body copy.</p></body></html>', // content only
  ])('a page missing one field is still valid: %s', (html) => {
    expect(extractPage(html, `${BASE}/x/`).isEmpty).toBe(false);
  });

  it('an empty 200 page is unusable', () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><script src="/app.js"></script></head><body><div id="root"></div><script>window.boot()</script></body></html>';
    const page = extractPage(html, `${BASE}/app/`);
    expect(page.title).toBeNull();
    expect(page.h1).toBeNull();
    expect(page.canonicalUrl).toBeNull();
    expect(page.contentText).toBe('');
    expect(page.isEmpty).toBe(true);
    expect(page.htmlRedirect).toBeNull();
  });

  it('a canonical alone does not make a page usable', () => {
    expect(extractPage(`<html><head><link rel="canonical" href="${BASE}/x/"></head><body></body></html>`, `${BASE}/x/`).isEmpty).toBe(true);
  });

  it('Next.js error shell with and without redirect', () => {
    const withRedirect = extractPage(nextShell('/us/x/'), `${BASE}/x/`);
    expect(withRedirect.isErrorShell).toBe(true);
    expect(withRedirect.htmlRedirect).not.toBeNull();
    const page = extractPage(nextShell('/us/x/').replace('NEXT_REDIRECT', 'SOME_OTHER_ERROR'), `${BASE}/x/`);
    expect(page.isErrorShell).toBe(true);
    expect(page.htmlRedirect).toBeNull();
    expect(page.isEmpty).toBe(true);
    // An error shell is unusable even when it happens to carry a title.
    expect(isUnusable({ title: 'Error', h1: null, contentText: '', errorShell: true })).toBe(true);
    expect(isUnusable({ title: null, h1: null, contentText: 'Real text', errorShell: true })).toBe(false);
    expect(isNextErrorShell('<html id="__next_error__">')).toBe(true);
    expect(isNextErrorShell('<html>')).toBe(false);
  });

  it('real production response fixture (regression)', () => {
    const page = extractPage(FIXTURE, PROD_URL);
    expect(page.title).toBeNull();
    expect(page.h1).toBeNull();
    expect(page.canonicalUrl).toBeNull();
    expect(page.contentHtml).toBe('');
    expect(page.links).toEqual([]);
    expect(page.isErrorShell).toBe(true);
    expect(page.isEmpty).toBe(true);
    expect(page.htmlRedirect.target).toBe('/us/ai-readiness-assessment/');
    expect(page.htmlRedirect.statusCode).toBe(307);
    expect(page.htmlRedirect.type).toBe(NEXT_REDIRECT);
  });
});

describe('crawler behaviour with HTML redirects', () => {
  const site = (routes = {}) => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    for (const [path, html] of Object.entries(routes)) mock.routes.set(path, [200, html, { 'content-type': 'text/html' }]);
    return mock;
  };
  const crawl = async (mock) => {
    const [crawler, store] = makeCrawler(mock);
    return [await crawler.crawl(makeSite(), crawlRequest({ use_sitemaps: false })), store];
  };

  it('follows the production Next.js redirect and excludes the source', async () => {
    const mock = site({ '/ai-readiness-assessment/': FIXTURE });
    mock.html('/', 'Home', '<p><a href="/ai-readiness-assessment/">Assessment</a></p>');
    mock.html('/us/ai-readiness-assessment/', 'AI Readiness Assessment', '<h1>Is Your Business Ready for AI?</h1><p>Take the assessment.</p>');
    const [report, store] = await crawl(mock);
    const source = store.pages.get(`${BASE}/ai-readiness-assessment/`);
    expect(source.http_status).toBe(200); // the true HTTP status is kept
    expect(source.redirect_url).toBe(`${BASE}/us/ai-readiness-assessment/`);
    expect(source.is_indexable).toBe(false); // never a normal content page
    const target = store.pages.get(`${BASE}/us/ai-readiness-assessment/`);
    expect(target.title).toBe('AI Readiness Assessment');
    expect(target.is_indexable).toBe(true);
    expect(target.redirect_url).toBeNull();
    expect(report.html_redirects).toBe(1);
    expect(report.unusable_pages).toBe(0);
    expect(report.errors).toEqual([]);
  });

  it('normalises and follows an absolute same-host target', async () => {
    const mock = site({ '/old/': nextShell(`${BASE}/us/new/?utm_source=x#top`) });
    mock.html('/', 'Home', '<p><a href="/old/">old</a></p>');
    mock.html('/us/new/', 'New', '<p>new page</p>');
    const [, store] = await crawl(mock);
    expect(store.pages.get(`${BASE}/old/`).redirect_url).toBe(`${BASE}/us/new/`);
    expect(store.pages.has(`${BASE}/us/new/`)).toBe(true);
  });

  it('records but does not follow an external target', async () => {
    const mock = site({ '/out/': nextShell('https://example.org/landing/') });
    mock.html('/', 'Home', '<p><a href="/out/">out</a></p>');
    const [, store] = await crawl(mock);
    const out = store.pages.get(`${BASE}/out/`);
    expect(out.redirect_url).toBe('https://example.org/landing/');
    expect(out.is_indexable).toBe(false);
    expect(mock.requests.some((u) => u.includes('example.org'))).toBe(false);
  });

  it.each([nextShell('javascript:alert(1)'), metaRefresh('0;url=javascript:alert(1)'), metaRefresh('0;url=data:text/html,hi')])(
    'rejects unsafe targets (%#)',
    async (html) => {
      const mock = site({ '/bad/': html });
      mock.html('/', 'Home', '<p><a href="/bad/">bad</a></p>');
      const [report, store] = await crawl(mock);
      expect(store.pages.get(`${BASE}/bad/`).redirect_url).toBeNull(); // never stored/followed as a redirect
      expect(report.errors.some((e) => e.url === `${BASE}/bad/` && e.error.includes('unsafe'))).toBe(true);
      expect(mock.requestedPaths().filter((p) => p !== '/robots.txt')).toHaveLength(2);
    },
  );

  it('does not follow an SSRF target', async () => {
    const mock = site({ '/meta/': metaRefresh('0;url=http://127.0.0.1/admin') });
    mock.html('/', 'Home', '<p><a href="/meta/">m</a></p>');
    const [report, store] = await crawl(mock);
    expect(mock.requests.some((u) => u.includes('127.0.0.1'))).toBe(false);
    expect(store.pages.get(`${BASE}/meta/`).is_indexable).toBe(false);
    expect(report.errors.some((e) => e.error.includes('SSRF'))).toBe(true);
  });

  it('follows a meta refresh redirect', async () => {
    const mock = site({ '/moved/': metaRefresh('0;url=/us/example/') });
    mock.html('/', 'Home', '<p><a href="/moved/">moved</a></p>');
    mock.html('/us/example/', 'Example', '<p>example</p>');
    const [report, store] = await crawl(mock);
    expect(store.pages.get(`${BASE}/moved/`).redirect_url).toBe(`${BASE}/us/example/`);
    expect(store.pages.get(`${BASE}/us/example/`).title).toBe('Example');
    expect(report.html_redirects).toBe(1);
  });

  it('stores an empty 200 page as not indexable', async () => {
    const mock = site({ '/empty/': '<html><head></head><body><div id="app"></div><script>boot()</script></body></html>' });
    mock.html('/', 'Home', '<p><a href="/empty/">empty</a></p>');
    const [report, store] = await crawl(mock);
    const page = store.pages.get(`${BASE}/empty/`);
    expect(page.http_status).toBe(200);
    expect(page.is_indexable).toBe(false);
    expect(page.redirect_url).toBeNull();
    expect(store.pages.get(`${BASE}/`).is_indexable).toBe(true);
    expect(report.unusable_pages).toBe(1);
    expect(report.html_redirects).toBe(0);
  });

  it('terminates an HTML redirect loop', async () => {
    const mock = site({ '/a/': nextShell('/b/'), '/b/': metaRefresh('0;url=/a/') });
    mock.html('/', 'Home', '<p><a href="/a/">a</a></p>');
    const [report, store] = await crawl(mock);
    const paths = mock.requestedPaths();
    expect(paths.filter((p) => p === '/a/')).toHaveLength(1);
    expect(paths.filter((p) => p === '/b/')).toHaveLength(1);
    expect(store.pages.get(`${BASE}/a/`).redirect_url).toBe(`${BASE}/b/`);
    expect(store.pages.get(`${BASE}/b/`).redirect_url).toBe(`${BASE}/a/`);
    expect(report.pages_crawled).toBe(3);
  });

  it('does not fetch a robots-disallowed redirect target', async () => {
    const mock = site({ '/r/': nextShell('/private/x/') });
    mock.add('/robots.txt', 200, 'User-agent: *\nDisallow: /private/\n');
    mock.html('/', 'Home', '<p><a href="/r/">r</a></p>');
    const [report] = await crawl(mock);
    expect(mock.requestedPaths()).not.toContain('/private/x/');
    expect(report.skipped_reasons.ROBOTS_DISALLOWED).toBe(1);
  });
});
