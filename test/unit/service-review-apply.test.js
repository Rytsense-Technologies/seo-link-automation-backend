// Port of tests/unit/test_service_review_apply.py
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictError, NotFoundError } from '../../src/utils/errors.js';
import { LinkApplicationError } from '../../src/interlink/apply.js';
import { SuggestionStatus } from '../../src/interlink/repository.js';
import { FakeContentStore, buildService, makeSiteFixture } from '../helpers/fakes.js';

const CONTEXT = 'Businesses can use AI voice agents to automate repetitive customer support interactions.';
const count = (s, needle) => s.split(needle).length - 1;

describe('review and apply', () => {
  let site;
  beforeEach(() => {
    site = makeSiteFixture();
  });

  const suggestion = (status = SuggestionStatus.PENDING, overrides = {}) =>
    site.repo.putSuggestion({
      source_page_id: site.source.id,
      target_page_id: site.voice.id,
      anchor_text: 'AI voice agents',
      context: CONTEXT,
      status,
      ...overrides,
    });
  const apply = (s, store = null) => buildService(site.repo, null, { store: store ?? new FakeContentStore() }).apply(s.id);

  // ---------------------------------------------------------------- approve / reject
  it('approve flow', async () => {
    const s = suggestion();
    const result = await buildService(site.repo).approve(s.id);
    expect(result.status).toBe(SuggestionStatus.APPROVED);
    expect(result.reviewed_at).not.toBeNull();
    expect(site.repo.commits).toBe(1);
  });

  it('reject flow with reason', async () => {
    const s = suggestion();
    const result = await buildService(site.repo).reject(s.id, 'Not a good fit');
    expect(result.status).toBe(SuggestionStatus.REJECTED);
    expect(result.rejection_reason).toBe('Not a good fit');
  });

  it('rejected can be re-approved and approved can be rejected', async () => {
    const s = suggestion(SuggestionStatus.REJECTED, { rejection_reason: 'x' });
    const service = buildService(site.repo);
    expect((await service.approve(s.id)).rejection_reason).toBeNull();
    expect((await service.reject(s.id, null)).status).toBe(SuggestionStatus.REJECTED);
  });

  it('re-approve conflicts with a newer active suggestion', async () => {
    const old = suggestion(SuggestionStatus.REJECTED);
    suggestion(SuggestionStatus.PENDING);
    const err = await buildService(site.repo).approve(old.id).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('ACTIVE_SUGGESTION_EXISTS');
  });

  it.each([
    [SuggestionStatus.APPROVED, 'approve'],
    [SuggestionStatus.APPLIED, 'approve'],
    [SuggestionStatus.REJECTED, 'reject'],
    [SuggestionStatus.APPLIED, 'reject'],
  ])('invalid transition from %s via %s', async (status, action) => {
    const s = suggestion(status);
    const service = buildService(site.repo);
    const err = await (action === 'approve' ? service.approve(s.id) : service.reject(s.id, null)).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('INVALID_STATUS_TRANSITION');
    expect(s.status).toBe(status);
  });

  it('unknown suggestion', async () => {
    const service = buildService(site.repo);
    for (const call of [service.approve.bind(service), service.apply.bind(service), service.getSuggestion.bind(service)]) {
      const err = await call(randomUUID()).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundError);
      expect(err.code).toBe('SUGGESTION_NOT_FOUND');
    }
  });

  // ---------------------------------------------------------------- apply
  it('apply flow', async () => {
    const s = suggestion(SuggestionStatus.APPROVED);
    const store = new FakeContentStore();
    const before = site.source.content_html ?? '';
    const result = await apply(s, store);
    expect(result.status).toBe(SuggestionStatus.APPLIED);
    expect(result.applied_at).not.toBeNull();
    const after = site.source.content_html ?? '';
    expect(after).toContain('<a href="/ai-voice-agent/">AI voice agents</a> to automate repetitive');
    expect(count(after, 'href="/ai-voice-agent/"')).toBe(1);
    // Script/style/nav/footer occurrences are untouched and nothing else changed.
    expect(after.replace('<a href="/ai-voice-agent/">AI voice agents</a>', 'AI voice agents')).toBe(before);
    expect(after).toContain('var promo = "AI voice agents"');
    expect(site.source.content_version).toBe(2);
    expect(site.source.outgoing_links).toContain(site.voice.url);
    expect(store.saved).toHaveLength(1);
  });

  it('apply requires APPROVED status', async () => {
    for (const status of [SuggestionStatus.PENDING, SuggestionStatus.REJECTED, SuggestionStatus.APPLIED]) {
      site.repo.suggestions.clear();
      const s = suggestion(status);
      const err = await apply(s).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe('SUGGESTION_NOT_APPROVED');
    }
    expect(site.repo.rollbacks).toBe(3);
  });

  it('applying twice is rejected', async () => {
    const s = suggestion(SuggestionStatus.APPROVED);
    await apply(s);
    await expect(apply(s)).rejects.toBeInstanceOf(ConflictError);
    expect(count(site.source.content_html ?? '', 'href="/ai-voice-agent/"')).toBe(1);
  });

  it('apply detects an existing link', async () => {
    site.source.content_html = (site.source.content_html ?? '').replace(
      '</body>',
      '<p>See <a href="https://example.com/ai-voice-agent">our agents</a>.</p></body>',
    );
    const s = suggestion(SuggestionStatus.APPROVED);
    const store = new FakeContentStore();
    const err = await apply(s, store).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('ALREADY_LINKED');
    expect(store.saved).toEqual([]);
    expect(s.status).toBe(SuggestionStatus.APPROVED);
  });

  it('apply revalidates the target', async () => {
    const s = suggestion(SuggestionStatus.APPROVED);
    site.voice.has_noindex = true;
    let err = await apply(s).catch((e) => e);
    expect(err.code).toBe('TARGET_NOT_LINKABLE');
    expect(err.details).toEqual({ reason: 'NOINDEX' });

    site.voice.has_noindex = false;
    site.voice.canonical_url = 'https://www.example.com/somewhere-else/';
    err = await apply(s).catch((e) => e);
    expect(err.details).toEqual({ reason: 'CANONICAL_POINTS_ELSEWHERE' });

    site.voice.canonical_url = null;
    site.voice.http_status = 404;
    err = await apply(s).catch((e) => e);
    expect(err.details).toEqual({ reason: 'HTTP_404' });
  });

  it('apply when pages disappeared', async () => {
    const s = suggestion(SuggestionStatus.APPROVED);
    site.repo.pages.delete(site.voice.id);
    let err = await apply(s).catch((e) => e);
    expect(err.code).toBe('TARGET_PAGE_MISSING');
    site.repo.pages.delete(site.source.id);
    err = await apply(s).catch((e) => e);
    expect(err.code).toBe('SOURCE_PAGE_MISSING');
  });

  it('apply when the context was edited away', async () => {
    const s = suggestion(SuggestionStatus.APPROVED);
    site.source.content_html = '<p>The page was rewritten entirely.</p>';
    const store = new FakeContentStore();
    const err = await apply(s, store).catch((e) => e);
    expect(err).toBeInstanceOf(LinkApplicationError);
    expect(err.code).toBe('CONTEXT_NOT_FOUND');
    expect(store.saved).toEqual([]);
    expect(s.status).toBe(SuggestionStatus.APPROVED);
  });

  it('apply never creates a nested link', async () => {
    site.source.content_html =
      '<p>Businesses can use <a href="/pricing/">AI voice agents</a> to automate repetitive customer support interactions.</p>';
    site.source.outgoing_links = ['https://www.example.com/pricing/'];
    const s = suggestion(SuggestionStatus.APPROVED);
    const err = await apply(s).catch((e) => e);
    expect(err).toBeInstanceOf(LinkApplicationError);
    expect(err.code).toBe('ANCHOR_IN_UNSAFE_ELEMENT');
  });

  it('apply content version conflict', async () => {
    const s = suggestion(SuggestionStatus.APPROVED);
    class RacingStore extends FakeContentStore {
      async saveContent() {
        throw new ConflictError('changed', { code: 'CONTENT_VERSION_CONFLICT' });
      }
    }
    const err = await apply(s, new RacingStore()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe('CONTENT_VERSION_CONFLICT');
    expect(s.status).toBe(SuggestionStatus.APPROVED);
  });
});
