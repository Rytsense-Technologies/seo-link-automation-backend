// Port of tests/unit/test_crawler_urls.py
import { describe, expect, it } from 'vitest';
import { urlKey } from '../../src/utils/urls.js';
import { SiteScope, isAsset, looksLikeTrap, normalizeCrawlUrl } from '../../src/crawler/urls.js';

describe('crawler urls', () => {
  it.each([
    'https://example.com/page',
    'https://example.com/page/',
    'https://example.com/page/#section',
    'https://example.com/page?utm_source=x',
    'https://example.com/page?utm_campaign=x&utm_medium=y',
    'https://example.com/page/?gclid=abc&fbclid=def',
    'HTTPS://EXAMPLE.COM:443/page#top',
    'https://example.com//page',
  ])('variant %s normalises to one page', (variant) => {
    const normalised = normalizeCrawlUrl(variant);
    expect(normalised).not.toBeNull();
    expect(normalised).not.toMatch(/#|utm_|clid/);
    expect(urlKey(normalised)).toBe(urlKey('https://example.com/page'));
  });

  it('keeps and sorts meaningful query parameters', () => {
    expect(normalizeCrawlUrl('https://example.com/list?page=2&utm_source=x&cat=ai')).toBe('https://example.com/list?cat=ai&page=2');
    expect(urlKey(normalizeCrawlUrl('/list?page=2', 'https://example.com/') ?? '')).not.toBe(urlKey('https://example.com/list'));
  });

  it.each(['mailto:a@example.com', 'tel:+123', 'javascript:void(0)', 'ftp://example.com/x', ''])('unsupported scheme %s', (raw) => {
    expect(normalizeCrawlUrl(raw, 'https://example.com/')).toBeNull();
  });

  it('resolves relative URLs against the base', () => {
    expect(normalizeCrawlUrl('../about/', 'https://example.com/blog/post/')).toBe('https://example.com/blog/about/');
  });

  it('same-domain scope', () => {
    const scope = SiteScope.forSite('https://rytsensetech.com/');
    expect(scope.contains('https://rytsensetech.com/services/')).toBe(true);
    expect(scope.contains('http://rytsensetech.com/')).toBe(true);
    expect(scope.contains('https://www.rytsensetech.com/services/')).toBe(false); // not permitted by default
    for (const external of [
      'https://facebook.com/rytsense',
      'https://www.linkedin.com/company/rytsense',
      'https://rytsensetech.com.evil.com/',
      'https://evilrytsensetech.com/',
      'https://sub.rytsensetech.com/',
      'mailto:hello@rytsensetech.com',
    ]) {
      expect(scope.contains(external), external).toBe(false);
    }
  });

  it('www variant only when explicitly permitted', () => {
    const scope = SiteScope.forSite('https://rytsensetech.com/', { includeWwwVariant: true });
    expect(scope.contains('https://www.rytsensetech.com/x')).toBe(true);
    expect(scope.contains('https://rytsensetech.com/x')).toBe(true);
    const reverse = SiteScope.forSite('https://www.example.com/', { includeWwwVariant: true });
    expect(reverse.contains('https://example.com/')).toBe(true);
  });

  it.each([
    ['https://example.com/logo.png', true],
    ['https://example.com/_next/static/app.js', true],
    ['https://example.com/styles/site.css', true],
    ['https://example.com/fonts/inter.woff2', true],
    ['https://example.com/brochure.PDF', true],
    ['https://example.com/sitemap.xml', true],
    ['https://example.com/services/', false],
    ['https://example.com/v2.0/release-notes', false],
    ['https://example.com/about', false],
  ])('asset detection %s -> %s', (url, asset) => {
    expect(isAsset(url)).toBe(asset);
  });

  it('crawler trap detection', () => {
    expect(looksLikeTrap('https://example.com/a/a/a/a/')).toBe(true);
    expect(looksLikeTrap(`https://example.com/${Array.from({ length: 20 }, (_, i) => `s${i}`).join('/')}`)).toBe(true);
    expect(looksLikeTrap(`https://example.com/x?${Array.from({ length: 8 }, (_, i) => `p${i}=1`).join('&')}`)).toBe(true);
    expect(looksLikeTrap(`https://example.com/${'a'.repeat(2100)}`)).toBe(true);
    expect(looksLikeTrap('https://example.com/blog/2026/09/post/')).toBe(false);
  });
});
