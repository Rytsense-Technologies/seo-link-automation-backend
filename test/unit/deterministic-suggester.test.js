// Phase 2: deterministic anchor/context generation (no AI).
import { describe, expect, it } from 'vitest';
import {
  anchorPhrases,
  deterministicItem,
  deterministicReason,
  findPlacements,
  splitSentences,
} from '../../src/interlink/deterministic-suggester.js';
import { buildTermWeights } from '../../src/interlink/relevance-scorer.js';
import { makePage } from '../helpers/fakes.js';

const flat = () => 1;

describe('sentence splitting', () => {
  it('splits body copy into sentences and drops fragments', () => {
    const block = 'Our AI voice agents answer calls. They route tickets to agents! Short one. What about a CRM integration? 3 steps are enough for most teams.';
    expect(splitSentences(block)).toEqual([
      'Our AI voice agents answer calls.',
      'They route tickets to agents!',
      'What about a CRM integration?',
      '3 steps are enough for most teams.',
    ]);
  });

  it('keeps decimals and abbreviations inside a sentence', () => {
    expect(splitSentences('Version 2.5 of the platform ships with voice agents today.')).toHaveLength(1);
  });

  it('drops overly long blocks without sentence breaks', () => {
    expect(splitSentences('word '.repeat(120).trim())).toEqual([]);
  });
});

describe('anchor phrases', () => {
  it('come from title, H1 and keywords, most specific first', () => {
    const target = makePage('/ai-voice-agent/', {
      title: 'AI Voice Agent for Customer Support | Example Inc',
      h1: 'AI Voice Agents',
      keywords: ['voice ai'],
    });
    const phrases = anchorPhrases(target, flat).map((p) => p.phrase);
    expect(phrases[0]).toBe('AI Voice Agent for Customer Support');
    expect(phrases).toContain('AI Voice Agents');
    expect(phrases).toContain('voice ai');
    // Never across the title separator, never with dangling stopwords.
    expect(phrases.some((p) => p.includes('|') || p.includes('Support Example'))).toBe(false);
    expect(phrases.some((p) => /^(for|the)\b|\b(for|the)$/i.test(p))).toBe(false);
  });

  it('rejects phrases made only of generic business words', () => {
    const target = makePage('/software-development-services/', { title: 'Software Development Services Company' });
    expect(anchorPhrases(target, flat)).toEqual([]);
  });

  it('rejects low-weight phrases (brand/boilerplate shared by every page)', () => {
    const src = makePage('/s/', { title: 'Acme' });
    const pages = Array.from({ length: 20 }, (_, i) => makePage(`/p${i + 1}/`, { title: `Acme Corp Topic${i + 1}` }));
    const weight = buildTermWeights(src, pages);
    const phrases = anchorPhrases(pages[0], weight).map((p) => p.phrase.toLowerCase());
    expect(phrases).not.toContain('acme');
    expect(phrases).not.toContain('acme corp');
    expect(phrases).toContain('topic1');
  });

  it('single words must be specific', () => {
    expect(anchorPhrases(makePage('/x/', { title: 'Chatbots' }), flat).map((p) => p.phrase)).toEqual(['Chatbots']);
    expect(anchorPhrases(makePage('/x/', { title: 'AI' }), flat)).toEqual([]);
  });
});

describe('placements', () => {
  const target = makePage('/ai-voice-agent/', { title: 'AI Voice Agents', keywords: ['voice agents'] });
  const sentences = [
    'We build chat tools for every channel.',
    'Businesses can use ai voice agents to automate support.',
    'Voice agents also help with scheduling appointments.',
  ];

  it('uses the exact source text as anchor and the sentence verbatim as context', () => {
    const placements = findPlacements(target, sentences, flat);
    expect(placements[0]).toEqual({ anchor: 'ai voice agents', context: sentences[1], field: 'title' });
    // Shorter alternatives are kept for validation; other sentences are found too.
    expect(placements.map((p) => p.context)).toContain(sentences[2]);
    expect(placements.find((p) => p.context === sentences[2]).anchor).toBe('Voice agents');
    for (const p of placements) expect(p.context.includes(p.anchor)).toBe(true);
  });

  it('never proposes an anchor absent from the source', () => {
    expect(findPlacements(makePage('/crm/', { title: 'CRM Integration' }), sentences, flat)).toEqual([]);
  });

  it('matches whole words only', () => {
    const t = makePage('/agent/', { title: 'Agent' });
    expect(findPlacements(t, ['Our agents and reagents are fine today.'], flat)).toEqual([]);
  });

  it('skips sentences and anchors already used in this run', () => {
    const usedContexts = new Set(['businesses can use ai voice agents to automate support.']);
    const out = findPlacements(target, sentences, flat, { usedContexts });
    expect(out.every((p) => p.context !== sentences[1])).toBe(true);
    const usedAnchors = new Set(['voice agents']);
    const anchors = findPlacements(target, sentences, flat, { usedAnchors }).map((p) => p.anchor.toLowerCase());
    expect(anchors[0]).toBe('ai voice agents');
    expect(anchors).not.toContain('voice agents');
  });

  it('builds an item in the AI item shape with a factual reason', () => {
    const placement = { anchor: 'AI voice agents', context: sentences[1], field: 'h1' };
    const item = deterministicItem(target, placement, { score: 0.734, signals: { content_title: 1, phrase_overlap: 0.5, quality: 1 } });
    expect(item).toMatchObject({
      target_page_id: target.id,
      target_url: target.url,
      is_relevant: true,
      relevance_score: 73,
      anchor_text: 'AI voice agents',
      suggested_context: sentences[1],
    });
    expect(item.reason).toBe(
      'The source sentence already mentions "AI voice agents", which matches the target page\'s H1. ' +
        'Strongest deterministic signals: content_title 1.00, phrase_overlap 0.50.',
    );
    expect(deterministicReason(placement, {})).toContain('signals: none.');
  });
});
