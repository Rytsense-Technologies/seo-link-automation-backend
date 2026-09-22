// Port of tests/unit/test_urls.py
import { describe, expect, it } from 'vitest';
import { normalizeUrl, sameHost, siteRelative, urlKey } from '../../src/utils/urls.js';

describe('core url helpers', () => {
  it('normalize_url', () => {
    expect(normalizeUrl('HTTPS://Example.COM:443/a/b?x=1#frag')).toBe('https://example.com/a/b?x=1');
    expect(normalizeUrl('/about', 'https://example.com/x/')).toBe('https://example.com/about');
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/');
    expect(normalizeUrl('mailto:a@b.c')).toBeNull();
    expect(normalizeUrl('javascript:void(0)')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });

  it('url_key equivalence', () => {
    expect(urlKey('https://www.example.com/a/')).toBe(urlKey('http://example.com/a'));
    expect(urlKey('https://example.com/a?x=1')).not.toBe(urlKey('https://example.com/a'));
  });

  it('host and relative', () => {
    expect(sameHost('https://www.example.com/a', 'https://example.com/b')).toBe(true);
    expect(sameHost('https://example.com/a', 'https://other.com/a')).toBe(false);
    expect(siteRelative('https://example.com/a/b?x=1')).toBe('/a/b?x=1');
  });
});
