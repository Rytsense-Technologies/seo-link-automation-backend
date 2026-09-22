/**
 * Test doubles (port of tests/fakes.py + tests/conftest.py): page factory, in-memory repository
 * and content store, fake AI provider, and the shared "site" fixture. No DB, no network, no AI.
 */

import { randomUUID } from 'node:crypto';
import { loadSettings } from '../../src/config/config.js';
import { internalLinksFor } from '../../src/content/store.js';
import { ConflictError } from '../../src/utils/errors.js';
import { AIProvider } from '../../src/interlink/provider.js';
import { LexicalCandidateRetriever } from '../../src/interlink/candidate-retriever.js';
import { RelevanceAnalyzer } from '../../src/interlink/relevance-analyzer.js';
import { ACTIVE_STATUSES, SuggestionStatus } from '../../src/interlink/repository.js';
import { InterlinkService, interlinkConfigFromSettings } from '../../src/interlink/service.js';

export const SITE_ID = '00000000-0000-0000-0000-00000000517e';
export const BASE = 'https://www.example.com';

/** Settings with no environment and no .env (like `Settings(_env_file=None)` in isolation). */
export const cleanSettings = (overrides = {}) => loadSettings({ env: {}, envFile: null, overrides });

export function makePage(path, { siteId = SITE_ID, ...overrides } = {}) {
  const url = `${BASE}${path}`;
  const values = {
    id: randomUUID(),
    site_id: siteId,
    url,
    title: null,
    h1: null,
    meta_description: null,
    content_html: null,
    content_version: 1,
    canonical_url: null,
    http_status: 200,
    redirect_url: null,
    is_indexable: true,
    has_noindex: false,
    language: 'en',
    region: null,
    page_type: null,
    keywords: [],
    outgoing_links: null,
    last_crawled_at: null,
    ...overrides,
  };
  if (values.outgoing_links === null) {
    values.outgoing_links = values.content_html ? internalLinksFor(url, values.content_html) : [];
  }
  return values;
}

export class FakeAIProvider extends AIProvider {
  static providerName = 'fake';

  constructor(response) {
    super('fake-model-1');
    this.response = response;
    this.calls = [];
  }

  async generateJson({ system, prompt }) {
    this.calls.push({ system, prompt });
    if (this.response instanceof Error) throw this.response;
    if (typeof this.response === 'function') return this.response(prompt);
    return this.response;
  }
}

const nowIso = () => new Date().toISOString();
const time = (v) => new Date(v).getTime();

export class FakeInterlinkRepository {
  constructor(pages = []) {
    this.pages = new Map(pages.map((p) => [p.id, p]));
    this.suggestions = new Map();
    this.commits = 0;
    this.rollbacks = 0;
  }

  // pages
  addPage(page) {
    this.pages.set(page.id, page);
    return page;
  }

  async getPage(pageId) {
    return this.pages.get(pageId) ?? null;
  }

  async listCandidatePool(source) {
    return [...this.pages.values()].filter((p) => p.site_id === source.site_id && p.id !== source.id);
  }

  async loadContents(pageIds) {
    return new Map(pageIds.filter((id) => this.pages.get(id)?.content_html).map((id) => [id, this.pages.get(id).content_html]));
  }

  // suggestions
  putSuggestion(values) {
    const now = nowIso();
    const suggestion = {
      id: randomUUID(),
      site_id: SITE_ID,
      anchor_text: 'anchor',
      context: 'context',
      relevance_score: 80,
      reason: 'reason',
      status: SuggestionStatus.PENDING,
      retrieval_score: 0.5,
      ai_provider: 'fake',
      ai_model: 'fake-model-1',
      rejection_reason: null,
      reviewed_at: null,
      applied_at: null,
      created_at: now,
      updated_at: now,
      ...values,
    };
    this.link(suggestion);
    this.suggestions.set(suggestion.id, suggestion);
    return suggestion;
  }

  link(s) {
    s.source_page = this.pages.get(s.source_page_id);
    s.target_page = this.pages.get(s.target_page_id);
  }

  async getSuggestion(id) {
    return this.suggestions.get(id) ?? null;
  }

  async listSuggestions(filters, { offset, limit }) {
    const items = [...this.suggestions.values()].filter(
      (s) =>
        (!filters.status || s.status === filters.status) &&
        (!filters.site_id || s.site_id === filters.site_id) &&
        (!filters.source_page_id || s.source_page_id === filters.source_page_id) &&
        (!filters.target_page_id || s.target_page_id === filters.target_page_id) &&
        (filters.min_relevance_score === null ||
          filters.min_relevance_score === undefined ||
          s.relevance_score >= filters.min_relevance_score),
    );
    items.sort((a, b) => time(b.created_at) - time(a.created_at) || b.relevance_score - a.relevance_score);
    return [items.slice(offset, offset + limit), items.length];
  }

  async activeTargetIds(sourcePageId) {
    return new Set(
      [...this.suggestions.values()]
        .filter((s) => s.source_page_id === sourcePageId && ACTIVE_STATUSES.includes(s.status))
        .map((s) => s.target_page_id),
    );
  }

  async rejectedTargetIdsSince(sourcePageId, since) {
    return new Set(
      [...this.suggestions.values()]
        .filter((s) => s.source_page_id === sourcePageId && s.status === SuggestionStatus.REJECTED && time(s.updated_at) >= time(since))
        .map((s) => s.target_page_id),
    );
  }

  async anchorsByTarget(targetIds) {
    const result = new Map();
    for (const s of this.suggestions.values()) {
      if (targetIds.includes(s.target_page_id) && ACTIVE_STATUSES.includes(s.status)) {
        if (!result.has(s.target_page_id)) result.set(s.target_page_id, []);
        result.get(s.target_page_id).push(s.anchor_text);
      }
    }
    return result;
  }

  activePairExists(s) {
    return [...this.suggestions.values()].some(
      (o) =>
        o.id !== s.id &&
        o.source_page_id === s.source_page_id &&
        o.target_page_id === s.target_page_id &&
        ACTIVE_STATUSES.includes(o.status),
    );
  }

  async addSuggestion(suggestion) {
    if (this.activePairExists(suggestion)) return false;
    const now = nowIso();
    suggestion.created_at = now;
    suggestion.updated_at = now;
    this.link(suggestion);
    this.suggestions.set(suggestion.id, suggestion);
    return true;
  }

  async saveSuggestion(suggestion) {
    suggestion.updated_at = nowIso();
  }

  async commit() {
    // Emulate the partial unique index being checked at commit.
    for (const s of this.suggestions.values()) {
      if (ACTIVE_STATUSES.includes(s.status) && this.activePairExists(s)) {
        throw new ConflictError('duplicate active pair', { code: 'ACTIVE_SUGGESTION_EXISTS' });
      }
    }
    this.commits += 1;
  }

  async rollback() {
    this.rollbacks += 1;
  }
}

export class FakeContentStore {
  constructor() {
    this.saved = [];
  }

  loadContent(page) {
    return page.content_html;
  }

  async saveContent(page, newContent, { expectedVersion }) {
    if (page.content_version !== expectedVersion) {
      throw new ConflictError('version conflict', { code: 'CONTENT_VERSION_CONFLICT' });
    }
    page.content_html = newContent;
    page.content_version = expectedVersion + 1;
    page.outgoing_links = internalLinksFor(page.url, newContent);
    this.saved.push([page.id, newContent]);
  }
}

export function defaultConfig(overrides = {}) {
  return { ...interlinkConfigFromSettings(cleanSettings()), ...overrides };
}

export function buildService(repo, provider = null, { config = null, store = null } = {}) {
  const factory = async () => {
    if (provider === null) throw new Error('AI provider must not be called in this test');
    return new RelevanceAnalyzer(provider, { sourceContentMaxChars: 6000, targetExcerptChars: 300 });
  };
  return new InterlinkService(repo, {
    config: config ?? defaultConfig(),
    retriever: new LexicalCandidateRetriever(),
    analyzerFactory: factory,
    contentStore: store ?? new FakeContentStore(),
  });
}

// ------------------------------------------------------------------ conftest.py

export const SOURCE_HTML = `<!doctype html>
<html><head><title>Customer support automation</title>
<script>var promo = "AI voice agents";</script>
<style>.x::after { content: "AI voice agents"; }</style></head>
<body>
<nav><a href="/">Home</a> AI voice agents</nav>
<h1>Customer Support Automation</h1>
<p>Businesses can use AI voice agents to automate repetitive customer support interactions.</p>
<p>Our <a href="/chatbots/">chatbot platform</a> handles chat, while a CRM integration keeps
customer records in sync across every tool.</p>
<p>Accurate dental insurance verification reduces claim denials for dental practices.</p>
<footer>AI voice agents &copy; Example</footer>
</body></html>`;

export function makeSiteFixture() {
  const source = makePage('/customer-support-automation/', {
    title: 'Customer Support Automation',
    h1: 'Customer Support Automation',
    keywords: ['customer support automation', 'voice agents', 'crm integration'],
    content_html: SOURCE_HTML,
    page_type: 'service',
  });
  const voice = makePage('/ai-voice-agent/', {
    title: 'AI Voice Agent for Customer Support',
    h1: 'AI Voice Agents',
    keywords: ['ai voice agent', 'voice ai', 'customer support'],
    meta_description: 'AI voice agents that answer and route customer support calls.',
    content_html: '<p>Our AI voice agents answer calls 24/7.</p>',
    page_type: 'service',
  });
  const crm = makePage('/crm-integration/', {
    title: 'CRM Integration Services',
    h1: 'CRM Integration',
    keywords: ['crm integration', 'customer records'],
    content_html: '<p>Sync customer records between your CRM and support tools.</p>',
  });
  const dental = makePage('/dental-insurance-verification/', {
    title: 'Dental Insurance Verification',
    h1: 'Dental Insurance Verification Automation',
    keywords: ['dental insurance verification', 'claim denials'],
  });
  const chatbots = makePage('/chatbots/', { title: 'Chatbot Platform for customer support' });
  const notFound = makePage('/old-voice-agent/', { title: 'AI voice agent (old)', http_status: 404 });
  const serverError = makePage('/voice-agent-pricing/', { title: 'Voice agent pricing', http_status: 503 });
  const redirected = makePage('/voice-agents/', {
    title: 'AI voice agents',
    http_status: 301,
    redirect_url: 'https://www.example.com/ai-voice-agent/',
  });
  const noindex = makePage('/voice-agent-beta/', { title: 'AI voice agent beta', has_noindex: true });
  const spanish = makePage('/es/agentes-de-voz/', { title: 'Agentes de voz con IA voice agents', language: 'es' });
  const utility = makePage('/privacy-policy/', { title: 'Privacy policy for customer support data' });
  const canonicalised = makePage('/blog/voice-ai-agents/', {
    title: 'Voice AI agents explained',
    canonical_url: 'https://www.example.com/ai-voice-agent/',
  });
  const unrelated = makePage('/bakery-recipes/', { title: 'Sourdough bakery recipes' });
  const pages = [source, voice, crm, dental, chatbots, notFound, serverError, redirected, noindex, spanish, utility, canonicalised, unrelated];
  return {
    source, voice, crm, dental, chatbots, notFound, serverError, redirected, noindex, spanish, utility, canonicalised, unrelated,
    repo: new FakeInterlinkRepository(pages),
  };
}

export function aiItem(page, overrides = {}) {
  return {
    target_page_id: String(page.id),
    target_url: page.url.replace(/^https:\/\/www\.example\.com/, ''),
    is_relevant: true,
    relevance_score: 90,
    reason: 'The target page covers this topic.',
    anchor_text: 'anchor',
    suggested_context: 'context',
    ...overrides,
  };
}

export function voiceItem(site, overrides = {}) {
  return aiItem(site.voice, {
    relevance_score: 94,
    reason: 'The target page directly covers AI voice agents for customer support.',
    anchor_text: 'AI voice agents',
    suggested_context: 'Businesses can use AI voice agents to automate repetitive customer support interactions.',
    ...overrides,
  });
}

export function crmItem(site, overrides = {}) {
  return aiItem(site.crm, {
    relevance_score: 82,
    reason: 'The target page describes CRM integration for syncing customer records.',
    anchor_text: 'CRM integration',
    suggested_context: 'Our chatbot platform handles chat, while a CRM integration keeps customer records in sync across every tool.',
    ...overrides,
  });
}
