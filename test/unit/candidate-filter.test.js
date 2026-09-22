// Port of tests/unit/test_candidate_filter.py
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExclusionReason, filterCandidates, filterConfig, targetExclusionReason } from '../../src/interlink/candidate-filter.js';
import { defaultConfig, makePage, makeSiteFixture } from '../helpers/fakes.js';

const cfg = () => defaultConfig().filters;

describe('candidate filter', () => {
  let site;
  beforeEach(() => {
    site = makeSiteFixture();
  });
  const reason = (attr) => targetExclusionReason(site.source, site[attr], cfg());

  it('excludes the source page', () => {
    expect(targetExclusionReason(site.source, site.source, cfg())).toBe(ExclusionReason.SOURCE_PAGE);
    // Same URL with a different trailing slash / host prefix is still the source.
    const twin = makePage('/customer-support-automation', { title: 'dup' });
    expect(targetExclusionReason(site.source, twin, cfg())).toBe(ExclusionReason.SOURCE_PAGE);
  });

  it('excludes 404 and 5xx targets', () => {
    expect(reason('notFound')).toBe(ExclusionReason.NOT_FOUND);
    expect(reason('serverError')).toBe(ExclusionReason.SERVER_ERROR);
  });

  it('excludes redirected targets', () => {
    expect(reason('redirected')).toBe(ExclusionReason.REDIRECTED);
    const silent = makePage('/moved/', { http_status: 308 });
    expect(targetExclusionReason(site.source, silent, cfg())).toBe(ExclusionReason.REDIRECTED);
  });

  it('excludes noindex and non-indexable targets', () => {
    expect(reason('noindex')).toBe(ExclusionReason.NOINDEX);
    const blocked = makePage('/blocked/', { is_indexable: false });
    expect(targetExclusionReason(site.source, blocked, cfg())).toBe(ExclusionReason.NOT_INDEXABLE);
  });

  it('excludes canonicals pointing elsewhere', () => {
    expect(reason('canonicalised')).toBe(ExclusionReason.CANONICAL_MISMATCH);
    const selfCanonical = makePage('/x/', { title: 'X', canonical_url: 'https://example.com/x' });
    expect(targetExclusionReason(site.source, selfCanonical, cfg())).toBeNull();
  });

  it('language and region mismatch', () => {
    expect(reason('spanish')).toBe(ExclusionReason.LANGUAGE_MISMATCH);
    const enUs = makePage('/us/voice/', { title: 'Voice US', language: 'en-US', region: 'us' });
    const enGb = makePage('/uk/voice/', { title: 'Voice UK', language: 'en-GB', region: 'gb' });
    expect(targetExclusionReason(enUs, enGb, cfg())).toBe(ExclusionReason.REGION_MISMATCH);
    const globalPage = makePage('/voice/', { title: 'Voice', language: 'en', region: null });
    expect(targetExclusionReason(enUs, globalPage, cfg())).toBeNull();
    const relaxed = filterConfig({ requireRegionMatch: false });
    expect(targetExclusionReason(enUs, enGb, relaxed)).toBeNull();
  });

  it('excludes utility pages', () => {
    expect(reason('utility')).toBe(ExclusionReason.UTILITY_PAGE);
    const typed = makePage('/some-page/', { page_type: 'legal' });
    expect(targetExclusionReason(site.source, typed, cfg())).toBe(ExclusionReason.UTILITY_PAGE);
    const pdf = makePage('/brochure.pdf');
    expect(targetExclusionReason(site.source, pdf, cfg())).toBe(ExclusionReason.UTILITY_PAGE);
  });

  it('excludes already linked targets', () => {
    expect(reason('chatbots')).toBe(ExclusionReason.ALREADY_LINKED);
  });

  it('excludes other sites', () => {
    const other = makePage('/ai-voice-agent/', { siteId: randomUUID() });
    expect(targetExclusionReason(site.source, other, cfg())).toBe(ExclusionReason.DIFFERENT_SITE);
  });

  it('dedupes URLs and groups reasons', async () => {
    const dup = makePage('/ai-voice-agent', { title: 'duplicate' }); // same page without slash
    const pool = [...(await site.repo.listCandidatePool(site.source)), dup];
    const result = filterCandidates(site.source, pool, cfg());
    expect(new Set(result.accepted.map((p) => p.url))).toEqual(
      new Set([site.voice.url, site.crm.url, site.dental.url, site.unrelated.url]),
    );
    expect(result.excluded.get(ExclusionReason.DUPLICATE_URL)).toEqual([dup]);
    expect(result.excluded.get(ExclusionReason.NOINDEX)).toContain(site.noindex);
  });

  it('excludes pages without usable content', () => {
    // Mirrors the empty 200 row stored by the first crawl (no title, H1 or content).
    const empty = makePage('/ai-readiness-assessment/', { title: null, h1: null, content_html: '' });
    expect(targetExclusionReason(site.source, empty, cfg())).toBe(ExclusionReason.EMPTY_CONTENT);
    const shell = makePage('/shell/', { title: '  ', content_html: '<script>boot()</script><div></div>' });
    expect(targetExclusionReason(site.source, shell, cfg())).toBe(ExclusionReason.EMPTY_CONTENT);
    // A single missing field is fine as long as the page has something usable.
    const noTitle = makePage('/no-title/', { h1: 'Heading only' });
    const bodyOnly = makePage('/body-only/', { content_html: '<p>Useful body copy.</p>' });
    const titleOnly = makePage('/title-only/', { title: 'Title only' });
    for (const page of [noTitle, bodyOnly, titleOnly]) {
      expect(targetExclusionReason(site.source, page, cfg()), page.url).toBeNull();
    }
  });
});
