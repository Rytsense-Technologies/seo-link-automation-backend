// Port of tests/unit/test_crawler_sitemap.py
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SitemapError, parseSitemap } from '../../src/crawler/sitemap.js';
import { BASE, MockSite, ROBOTS_ALLOW_ALL, crawlRequest, makeCrawler, makeSite } from '../helpers/crawler-fakes.js';

const NS = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
const urlset = (...paths) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset ${NS}>${paths.map((p) => `<url><loc>${BASE}${p}</loc><lastmod>2026-09-01</lastmod></url>`).join('')}</urlset>`;
const index = (...paths) => `<?xml version="1.0"?><sitemapindex ${NS}>${paths.map((p) => `<sitemap><loc>${BASE}${p}</loc></sitemap>`).join('')}</sitemapindex>`;
const gzip = (s) => zlib.gzipSync(Buffer.isBuffer(s) ? s : Buffer.from(s));
const MB = 10 ** 6;

describe('sitemaps', () => {
  it('parses urlset and index', () => {
    let parsed = parseSitemap(Buffer.from(urlset('/a/', '/b/')), { maxBytes: MB });
    expect(parsed.pageUrls).toEqual([`${BASE}/a/`, `${BASE}/b/`]);
    parsed = parseSitemap(Buffer.from(index('/page-sitemap.xml')), { maxBytes: MB });
    expect(parsed.childSitemaps).toEqual([`${BASE}/page-sitemap.xml`]);
    expect(parsed.pageUrls).toEqual([]);
  });

  it('parses gzip and plain text', () => {
    expect(parseSitemap(gzip(urlset('/gz/')), { maxBytes: MB }).pageUrls).toEqual([`${BASE}/gz/`]);
    expect(parseSitemap(Buffer.from(`${BASE}/t1/\n${BASE}/t2/\n`), { maxBytes: MB }).pageUrls).toEqual([`${BASE}/t1/`, `${BASE}/t2/`]);
  });

  it('rejects entities, bombs and garbage', () => {
    const evil = '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><urlset><url><loc>&a;</loc></url></urlset>';
    expect(() => parseSitemap(Buffer.from(evil), { maxBytes: MB })).toThrow(SitemapError);
    const bomb = gzip(Buffer.concat([Buffer.from('<urlset>'), Buffer.alloc(2_000_000, 0x20), Buffer.from('</urlset>')]));
    expect(() => parseSitemap(bomb, { maxBytes: 100_000 })).toThrow(/exceeds/);
    expect(() => parseSitemap(Buffer.from('<html><body>not a sitemap</body></html>'), { maxBytes: MB })).toThrow(SitemapError);
    expect(() => parseSitemap(Buffer.from('<urlset><url>'), { maxBytes: MB })).toThrow(SitemapError);
  });

  it('a sitemap index discovers pages not linked in navigation', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, `User-agent: *\nDisallow:\nSitemap: ${BASE}/sitemap_index.xml\n`);
    mock.add('/sitemap_index.xml', 200, index('/page-sitemap.xml', '/post-sitemap.xml.gz'));
    mock.add('/page-sitemap.xml', 200, urlset('/', '/orphan-service/'));
    mock.add('/post-sitemap.xml.gz', 200, gzip(urlset('/blog/hidden-post/', '/blog/hidden-post/?utm_source=x')));
    mock.html('/', 'Home', '<p>No links to the orphan pages here.</p>');
    mock.html('/orphan-service/', 'Orphan service', '<p>Only in sitemap.</p>');
    mock.html('/blog/hidden-post/', 'Hidden post', '<p>Only in sitemap.</p>');
    const [crawler, store] = makeCrawler(mock);
    const report = await crawler.crawl(makeSite(), crawlRequest());
    expect(report.sitemaps_processed).toBe(3);
    expect(report.robots.sitemaps).toEqual([`${BASE}/sitemap_index.xml`]);
    expect(new Set([...store.pages.keys()].map((u) => u.replace(BASE, '')))).toEqual(new Set(['/', '/orphan-service/', '/blog/hidden-post/']));
    expect(report.pages_discovered).toBe(3); // utm variant is not a separate page
    expect(report.errors).toEqual([]);
  });

  it('falls back to the conventional sitemap location', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.add('/sitemap.xml', 200, urlset('/from-default-sitemap/'));
    mock.html('/', 'Home', '<p>x</p>');
    mock.html('/from-default-sitemap/', 'Default', '<p>y</p>');
    const [crawler, store] = makeCrawler(mock);
    const report = await crawler.crawl(makeSite(), crawlRequest());
    expect(store.pages.has(`${BASE}/from-default-sitemap/`)).toBe(true);
    expect(report.sitemaps_processed).toBe(1);
  });

  it('a missing default sitemap is not an error and foreign entries are ignored', async () => {
    let mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.html('/', 'Home', '<p>x</p>');
    let [crawler] = makeCrawler(mock);
    expect((await crawler.crawl(makeSite(), crawlRequest())).errors).toEqual([]);

    mock = new MockSite();
    mock.add('/robots.txt', 200, 'User-agent: *\nSitemap: https://other.com/sitemap.xml\n');
    mock.add('/sitemap.xml', 200, urlset('/ok/').replace('</urlset>', '<url><loc>https://evil.com/x</loc></url></urlset>'));
    mock.html('/', 'Home', '<p>x</p>');
    mock.html('/ok/', 'Ok', '<p>x</p>');
    let store;
    [crawler, store] = makeCrawler(mock);
    const report = await crawler.crawl(makeSite(), crawlRequest());
    expect(mock.requests.every((u) => !u.includes('other.com') && !u.includes('evil.com'))).toBe(true);
    expect(report.errors.some((e) => e.error.includes('outside the site scope'))).toBe(true);
    expect(store.pages.has(`${BASE}/ok/`)).toBe(true);
  });

  it('use_sitemaps=false skips sitemaps', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, ROBOTS_ALLOW_ALL);
    mock.add('/sitemap.xml', 200, urlset('/x/'));
    mock.html('/', 'Home', '<p>x</p>');
    const [crawler] = makeCrawler(mock);
    const report = await crawler.crawl(makeSite(), crawlRequest({ use_sitemaps: false }));
    expect(mock.requestedPaths()).not.toContain('/sitemap.xml');
    expect(report.sitemaps_processed).toBe(0);
  });

  // Node-specific: nested sitemap indexes and XML entity decoding in <loc>.
  it('follows nested sitemap indexes and decodes XML entities', async () => {
    const mock = new MockSite();
    mock.add('/robots.txt', 200, `User-agent: *\nSitemap: ${BASE}/root-index.xml\n`);
    mock.add('/root-index.xml', 200, index('/nested-index.xml'));
    mock.add('/nested-index.xml', 200, index('/leaf.xml'));
    mock.add('/leaf.xml', 200, urlset('/deep/?a=1&amp;b=2'));
    mock.html('/', 'Home', '<p>x</p>');
    mock.html('/deep/', 'Deep', '<p>deep</p>');
    const [crawler] = makeCrawler(mock);
    const report = await crawler.crawl(makeSite(), crawlRequest());
    expect(report.sitemaps_processed).toBe(3);
    expect(mock.requestedPaths()).toContain('/deep/?a=1&b=2');
  });
});
