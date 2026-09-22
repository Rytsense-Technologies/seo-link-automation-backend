// Port of tests/unit/test_relevance_analyzer.py
// AI structured-response validation (the AI can only pick backend-provided candidates).
import { beforeEach, describe, expect, it } from 'vitest';
import { AIProviderError, parseJsonObject } from '../../src/interlink/provider.js';
import { RelevanceAnalyzer, parseAiResponse, validateAiItem } from '../../src/interlink/relevance-analyzer.js';
import { FakeAIProvider, aiItem, makeSiteFixture, voiceItem } from '../helpers/fakes.js';

describe('relevance analyzer', () => {
  let site;
  beforeEach(() => {
    site = makeSiteFixture();
  });
  const cands = () => [
    { page: site.voice, score: 0.8 },
    { page: site.crm, score: 0.5 },
  ];

  it('parses a valid response', () => {
    const result = parseAiResponse({ suggestions: [voiceItem(site)] }, cands());
    expect(result.items).toHaveLength(1);
    const [item] = result.items;
    expect(item.target_page_id).toBe(String(site.voice.id));
    expect(item.relevance_score).toBe(94);
    expect(item.anchor_text).toBe('AI voice agents');
  });

  it('discards unknown target ids', () => {
    const invented = aiItem(site.voice, { target_page_id: '11111111-1111-1111-1111-111111111111' });
    const result = parseAiResponse({ suggestions: [invented] }, cands());
    expect(result.items).toEqual([]);
    expect(Object.fromEntries(result.discarded)).toEqual({ '11111111-1111-1111-1111-111111111111': 'UNKNOWN_TARGET' });
  });

  it('discards a modified target url', () => {
    const result = parseAiResponse({ suggestions: [voiceItem(site, { target_url: '/some-invented-url/' })] }, cands());
    expect(result.items).toEqual([]);
    expect(result.discarded.get(String(site.voice.id))).toBe('TARGET_URL_MISMATCH');
  });

  it.each([
    [{ relevance_score: 150 }],
    [{ relevance_score: -1 }],
    [{ relevance_score: 'high' }],
    [{ anchor_text: '' }],
    [{ suggested_context: null }],
    [{ reason: '' }],
  ])('discards invalid items individually %j', (bad) => {
    const good = voiceItem(site);
    const broken = { ...aiItem(site.crm), ...bad };
    const result = parseAiResponse({ suggestions: [good, broken] }, cands());
    expect(result.items.map((i) => i.target_page_id)).toEqual([String(site.voice.id)]);
    expect(result.discarded.get(String(site.crm.id))).toBe('INVALID_AI_ITEM');
  });

  it('drops not-relevant items', () => {
    const result = parseAiResponse({ suggestions: [voiceItem(site, { is_relevant: false })] }, cands());
    expect(result.items).toEqual([]);
    expect(result.discarded.get(String(site.voice.id))).toBe('NOT_RELEVANT');
  });

  it.each([[[]], [{ items: [] }], [{ suggestions: 'none' }], [null]])('malformed top level %j raises', (raw) => {
    let caught;
    try {
      parseAiResponse(raw, cands());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIProviderError);
    expect(caught.code).toBe('AI_INVALID_RESPONSE');
  });

  it('parse_json_object handles fences and errors', () => {
    expect(parseJsonObject('```json\n{"suggestions": []}\n```')).toEqual({ suggestions: [] });
    expect(() => parseJsonObject('not json')).toThrow(AIProviderError);
    expect(() => parseJsonObject('[1, 2]')).toThrow(AIProviderError);
  });

  it('builds a compact prompt with only the candidates', () => {
    const provider = new FakeAIProvider({ suggestions: [] });
    const analyzer = new RelevanceAnalyzer(provider, { sourceContentMaxChars: 500, targetExcerptChars: 50 });
    const prompt = analyzer.buildPrompt({
      sourceUrl: site.source.url,
      sourceTitle: site.source.title,
      sourceH1: site.source.h1,
      sourceKeywords: site.source.keywords,
      sourceContent: 'x '.repeat(2000),
      candidates: cands(),
      candidateExcerpts: new Map([[String(site.voice.id), 'y '.repeat(500)]]),
      avoidAnchors: new Map([[String(site.voice.id), ['voice agents']]]),
    });
    const payload = JSON.parse(prompt);
    expect(payload.SOURCE.content.length).toBeLessThanOrEqual(502);
    expect(payload.CANDIDATES.map((c) => c.id)).toEqual([String(site.voice.id), String(site.crm.id)]);
    expect(payload.CANDIDATES[0].url).toBe('/ai-voice-agent/');
    expect(payload.CANDIDATES[0].avoid_anchors).toEqual(['voice agents']);
    expect(payload.CANDIDATES[0].excerpt.length).toBeLessThanOrEqual(52);
    expect(prompt).not.toContain(site.unrelated.url);
  });

  // Node-specific: the Pydantic lax-coercion rules measured on the Python model.
  it.each([
    [84.5, 84], [85.5, 86], [85.49, 85], ['85', 85], ['85.0', 85], [' 85 ', 85], [true, 1], [false, 0], [100.4, 100], [-0.4, 0],
  ])('relevance_score %j coerces to %j like Pydantic', (value, expected) => {
    expect(validateAiItem({ ...aiItem(site.voice), relevance_score: value }).relevance_score).toBe(expected);
  });

  it.each(['85.5', null, [85], 100.6])('relevance_score %j is rejected like Pydantic', (value) => {
    expect(() => validateAiItem({ ...aiItem(site.voice), relevance_score: value })).toThrow();
  });

  it.each([
    [true, true], ['yes', true], ['No', false], ['TRUE', true], ['t', true], ['on', true], ['1', true], [1, true], [0, false], [1.0, true],
  ])('is_relevant %j -> %j', (value, expected) => {
    expect(validateAiItem({ ...aiItem(site.voice), is_relevant: value }).is_relevant).toBe(expected);
  });

  it.each([2, 'maybe', null])('is_relevant %j is rejected', (value) => {
    expect(() => validateAiItem({ ...aiItem(site.voice), is_relevant: value })).toThrow();
  });

  it('strips strings and enforces string types/lengths', () => {
    const item = validateAiItem({ ...aiItem(site.voice), target_page_id: '  x  ', target_url: '  /a/  ' });
    expect(item.target_page_id).toBe('x');
    expect(item.target_url).toBe('/a/');
    for (const bad of [{ target_page_id: 5 }, { target_page_id: '   ' }, { target_url: 5 }, { reason: 'r'.repeat(2001) }, { anchor_text: 'a'.repeat(256) }]) {
      expect(() => validateAiItem({ ...aiItem(site.voice), ...bad })).toThrow();
    }
    expect(validateAiItem({ ...aiItem(site.voice), reason: 'r'.repeat(2000), extra: 1 }).reason).toHaveLength(2000);
  });
});
