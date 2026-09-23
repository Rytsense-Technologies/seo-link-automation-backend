// Phase 2: existing-link detection and target URL safety in the candidate filter.
import { describe, expect, it } from 'vitest';
import {
  ExclusionReason,
  filterConfig,
  hasTrackingParams,
  isAlternateVersion,
  linkKey,
  localeSegment,
  linkedUrlKeys,
  targetExclusionReason,
} from '../../src/interlink/candidate-filter.js';
import { internalLinksFor } from '../../src/content/store.js';
import { SITE_ID, makePage } from '../helpers/fakes.js';

const cfg = () => filterConfig({ utilityPathPatterns: [] });
const source = () => makePage('/source/', { title: 'Source' });
const target = () => makePage('/ai-voice-agent/', { title: 'AI Voice Agent' });

const linkedFrom = (html) => {
  const src = source();
  return linkedUrlKeys(internalLinksFor(src.url, html));
};

describe('existing link detection', () => {
  it.each([
    ['trailing slash', '<a href="/ai-voice-agent">x</a>'],
    ['fragment', '<a href="/ai-voice-agent/#pricing">x</a>'],
    ['tracking params', '<a href="/ai-voice-agent/?utm_source=nl&utm_medium=email">x</a>'],
    ['click ids', '<a href="/ai-voice-agent/?gclid=abc&fbclid=def">x</a>'],
    ['relative path', '<a href="../ai-voice-agent/">x</a>'],
    ['absolute URL', '<a href="https://www.example.com/ai-voice-agent/">x</a>'],
    ['http scheme', '<a href="http://www.example.com/ai-voice-agent/">x</a>'],
    ['host without www', '<a href="https://example.com/ai-voice-agent/">x</a>'],
    ['uppercase host', '<a href="https://WWW.EXAMPLE.COM/ai-voice-agent/">x</a>'],
    ['default port', '<a href="https://www.example.com:443/ai-voice-agent/">x</a>'],
  ])('treats a %s variant as already linked', (_, html) => {
    const reason = targetExclusionReason(source(), target(), cfg(), linkedFrom(html));
    expect(reason).toBe(ExclusionReason.ALREADY_LINKED);
  });

  it('stored outgoing_links with tracking params also count', () => {
    const src = makePage('/source/', { outgoing_links: ['https://www.example.com/ai-voice-agent/?utm_campaign=x#top'] });
    expect(targetExclusionReason(src, target(), cfg())).toBe(ExclusionReason.ALREADY_LINKED);
  });

  it('a different query string is a different page', () => {
    const reason = targetExclusionReason(source(), target(), cfg(), linkedFrom('<a href="/ai-voice-agent/?plan=pro">x</a>'));
    expect(reason).toBeNull();
  });

  it('linkKey unifies equivalent forms and keeps real differences', () => {
    const k = linkKey('https://www.example.com/a/');
    expect(linkKey('http://example.com/a?utm_source=x#frag')).toBe(k);
    expect(linkKey('https://www.example.com/b/')).not.toBe(k);
    expect(linkKey('https://www.example.com/a/?b=2&a=1')).toBe(linkKey('https://www.example.com/a/?a=1&b=2'));
    expect(() => linkKey('https://[bad/')).not.toThrow();
  });
});

describe('target URL safety', () => {
  it.each([
    ['mailto:', 'mailto:sales@example.com', ExclusionReason.DIFFERENT_SITE],
    ['tel:', 'tel:+15551234567', ExclusionReason.DIFFERENT_SITE],
    ['javascript:', 'javascript:alert(1)', ExclusionReason.DIFFERENT_SITE],
    ['external', 'https://evil.example.org/ai-voice-agent/', ExclusionReason.DIFFERENT_SITE],
  ])('never suggests %s targets', (_, url, expected) => {
    const page = { ...target(), url };
    expect(targetExclusionReason(source(), page, cfg())).toBe(expected);
  });

  it('excludes asset URLs', () => {
    for (const path of ['/brochure.pdf', '/logo.png', '/data.json', '/app.js']) {
      expect(targetExclusionReason(source(), makePage(path, { title: 'Asset' }), cfg())).toBe(ExclusionReason.ASSET_URL);
    }
  });

  it('excludes tracking-parameter URL variants', () => {
    const page = makePage('/ai-voice-agent/?utm_source=google', { title: 'AI Voice Agent' });
    expect(targetExclusionReason(source(), page, cfg())).toBe(ExclusionReason.TRACKING_URL);
    expect(hasTrackingParams('https://www.example.com/a/?gclid=1')).toBe(true);
    expect(hasTrackingParams('https://www.example.com/a/?page=2')).toBe(false);
    expect(hasTrackingParams('https://www.example.com/a/')).toBe(false);
  });

  it('excludes pages from a different site_id even on the same host', () => {
    const page = makePage('/ai-voice-agent/', { title: 'AI Voice Agent', siteId: '11111111-1111-1111-1111-111111111111' });
    expect(page.site_id).not.toBe(SITE_ID);
    expect(targetExclusionReason(source(), page, cfg())).toBe(ExclusionReason.DIFFERENT_SITE);
  });

  it('excludes redirect shells (HTTP 200 with redirect_url) and unusable pages', () => {
    const shell = makePage('/ai-readiness-assessment/', {
      title: 'AI readiness',
      redirect_url: 'https://www.example.com/us/ai-readiness-assessment/',
      is_indexable: false,
    });
    expect(targetExclusionReason(source(), shell, cfg())).toBe(ExclusionReason.REDIRECTED);
    const unusable = makePage('/empty/', { is_indexable: false, has_noindex: false, title: 'Empty' });
    expect(targetExclusionReason(source(), unusable, cfg())).toBe(ExclusionReason.NOT_INDEXABLE);
    const blank = makePage('/blank/', { title: null, h1: null, content_html: '<p>   </p>' });
    expect(targetExclusionReason(source(), blank, cfg())).toBe(ExclusionReason.EMPTY_CONTENT);
  });

  it('excludes a localised twin of the source when region metadata cannot tell them apart', () => {
    const src = makePage('/ai-chatbot-development-services/', { title: 'AI Chatbots', region: 'global' });
    const twin = makePage('/us/ai-chatbot-development-services/', { title: 'AI Chatbots USA', region: 'global' });
    expect(isAlternateVersion(src, twin)).toBe(true);
    expect(targetExclusionReason(src, twin, cfg())).toBe(ExclusionReason.ALTERNATE_VERSION);
    // Both directions, and between two locales.
    expect(targetExclusionReason(twin, src, cfg())).toBe(ExclusionReason.ALTERNATE_VERSION);
    const uk = makePage('/uk/ai-chatbot-development-services', { title: 'AI Chatbots UK', region: 'global' });
    expect(targetExclusionReason(twin, uk, cfg())).toBe(ExclusionReason.ALTERNATE_VERSION);
    // Different pages under a locale prefix are fine.
    const other = makePage('/us/ai-voice-agent/', { title: 'Voice', region: 'global' });
    expect(targetExclusionReason(src, other, cfg())).toBeNull();
    // Home pages and non-locale paths are never "twins".
    expect(isAlternateVersion(makePage('/'), makePage('/us/'))).toBe(false);
    expect(isAlternateVersion(makePage('/blog/x/'), makePage('/news/x/'))).toBe(false);
  });

  it('only treats real locale segments as locales, not topic sections', () => {
    // /it/ (IT services), /ai/, /qa/, /hr/ and /id/ are topics far more often than locales.
    for (const segment of ['it', 'ai', 'qa', 'hr', 'id', 'no', 'me', 'io']) {
      expect(localeSegment(`/${segment}/support/`)).toBeNull();
      const src = makePage('/support/', { title: 'Support', region: 'global' });
      const page = makePage(`/${segment}/support/`, { title: 'Support', region: 'global' });
      expect(targetExclusionReason(src, page, cfg())).toBeNull();
    }
    for (const segment of ['us', 'uk', 'de', 'ae', 'in', 'en-gb', 'pt_br']) {
      expect(localeSegment(`/${segment}/support/`)).toBe(segment);
    }
    expect(localeSegment('/blog/')).toBeNull();
    expect(localeSegment('/')).toBeNull();
  });

  it('leaves locale variants to the region rules when regions differ', () => {
    const us = makePage('/us/voice/', { title: 'Voice US', region: 'us' });
    const globalPage = makePage('/voice/', { title: 'Voice', region: null });
    expect(isAlternateVersion(us, globalPage)).toBe(false);
    expect(targetExclusionReason(us, globalPage, cfg())).toBeNull();
  });

  it('existing exclusion reasons keep their precedence', () => {
    // The default utility patterns still classify PDFs as utility pages.
    const pdf = makePage('/brochure.pdf', { title: 'Brochure' });
    expect(targetExclusionReason(source(), pdf, filterConfig({ utilityPathPatterns: ['\\.pdf$'] }))).toBe(ExclusionReason.UTILITY_PAGE);
  });
});
