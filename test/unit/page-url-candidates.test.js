// pageUrlCandidates: the stored-URL forms GET /api/pages/resolve looks up for a typed URL.
import { describe, expect, it } from 'vitest';
import { pageUrlCandidates } from '../../src/db/queries/pages.js';

describe('pageUrlCandidates', () => {
  it('puts the crawler-normalised URL first', () => {
    expect(pageUrlCandidates('HTTPS://Example.com:443/Services/?b=2&a=1#pricing')[0]).toBe(
      'https://example.com/Services/?a=1&b=2',
    );
  });

  it('drops tracking parameters but keeps content-selecting ones', () => {
    const [first] = pageUrlCandidates('https://example.com/page/?utm_source=x&gclid=y&lang=de');
    expect(first).toBe('https://example.com/page/?lang=de');
  });

  it('covers trailing-slash, www and scheme variants', () => {
    const candidates = pageUrlCandidates('https://example.com/services');
    expect(candidates).toEqual(
      expect.arrayContaining([
        'https://example.com/services',
        'https://example.com/services/',
        'https://www.example.com/services',
        'http://example.com/services/',
      ]),
    );
  });

  it('never invents paths for the home page', () => {
    const candidates = pageUrlCandidates('https://www.example.com');
    expect(new Set(candidates.map((url) => new URL(url).pathname))).toEqual(new Set(['/']));
  });

  it('returns nothing for URLs that are not absolute http(s)', () => {
    for (const bad of ['', '   ', 'example.com/page', '/relative/path', 'ftp://example.com/a', 'javascript:alert(1)', 'mailto:a@b.c']) {
      expect(pageUrlCandidates(bad)).toEqual([]);
    }
  });
});
