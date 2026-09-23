// Phase 2: deterministic, explainable relevance scoring.
import { describe, expect, it } from 'vitest';
import {
  GENERIC_TERMS,
  MIN_EVIDENCE,
  SIGNAL_WEIGHTS,
  buildTermWeights,
  coverage,
  mentionCredit,
  overlap,
  qualitySignal,
  rankTargets,
  regionLanguageSignal,
  scoreTarget,
  sourceProfile,
  tokenSet,
  topSignals,
} from '../../src/interlink/relevance-scorer.js';
import { makePage, makeSiteFixture } from '../helpers/fakes.js';

const SOURCE_TEXT = [
  'Businesses can use AI voice agents to automate repetitive customer support interactions.',
  'Our chatbot platform handles chat, while a CRM integration keeps customer records in sync across every tool.',
  'Accurate dental insurance verification reduces claim denials for dental practices.',
].join('\n');

const SIGNAL_NAMES = Object.keys(SIGNAL_WEIGHTS).sort();

function score(source, target, pool = [target]) {
  return scoreTarget(sourceProfile(source, SOURCE_TEXT), target, buildTermWeights(source, pool));
}

describe('relevance scorer', () => {
  it('signal weights sum to 1 and every signal is reported in [0, 1]', () => {
    const total = Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    const site = makeSiteFixture();
    const { score: s, signals } = score(site.source, site.voice);
    expect(Object.keys(signals).sort()).toEqual(SIGNAL_NAMES);
    for (const v of [s, ...Object.values(signals)]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('a relevant page scores higher than an unrelated page', () => {
    const site = makeSiteFixture();
    const pool = [site.voice, site.crm, site.dental, site.unrelated];
    const relevant = score(site.source, site.voice, pool);
    const unrelated = score(site.source, site.unrelated, pool);
    expect(relevant.score).toBeGreaterThan(0.4);
    expect(unrelated.score).toBe(0);
    expect(relevant.signals.content_title).toBeGreaterThan(0.5);
    expect(relevant.signals.slug_similarity).toBeGreaterThan(0.5);
  });

  it('a recurring topic outweighs a single passing mention in a long page', () => {
    const source = makePage('/ai-chatbot-development-services/', { title: 'AI Chatbot Development Services', h1: 'AI Chatbots' });
    const text = [
      'Our chatbots answer customers instantly.',
      'Enterprise chatbots integrate with your CRM.',
      'Multilingual chatbots serve every market.',
      'We also built one assistant for a financial firm.',
    ].join('\n');
    const chatbotGuide = makePage('/blog/enterprise-chatbots/', { title: 'Enterprise Chatbots Guide', h1: 'Enterprise Chatbots' });
    const financial = makePage('/industries/financial-software-development-services/', {
      title: 'Financial Software Development Services',
      h1: 'Financial Software Development Services',
    });
    const profile = sourceProfile(source, text);
    const weight = buildTermWeights(source, [chatbotGuide, financial]);
    const chat = scoreTarget(profile, chatbotGuide, weight);
    const fin = scoreTarget(profile, financial, weight);
    expect(fin.signals.content_title).toBeLessThan(0.5);
    expect(chat.score).toBeGreaterThan(fin.score);
  });

  it('mentionCredit saturates with repeated mentions', () => {
    expect(mentionCredit(0)).toBe(0);
    expect(mentionCredit(1)).toBeCloseTo(0.393, 3);
    expect(mentionCredit(5)).toBeGreaterThan(0.9);
    expect(mentionCredit(50)).toBeLessThanOrEqual(1);
  });

  it('context-free signals (quality, region) give no score without shared vocabulary', () => {
    const site = makeSiteFixture();
    const wellDescribed = makePage('/baking/', {
      title: 'Sourdough Baking',
      h1: 'Sourdough',
      meta_description: 'Bread.',
      keywords: ['sourdough'],
    });
    const result = score(site.source, wellDescribed, [wellDescribed]);
    expect(result.signals.quality).toBe(1);
    expect(result.signals.region_language).toBe(1);
    expect(result.score).toBe(0);
  });

  it('generic business words do not dominate', () => {
    const source = makePage('/a/', { title: 'Software Development Company', h1: 'Custom Software Development Services' });
    const generic = makePage('/software-development-services/', {
      title: 'Software Development Services Company',
      h1: 'Software Development Solutions',
    });
    const specific = makePage('/voice-agents/', { title: 'AI Voice Agents', h1: 'Voice Agents' });
    const text =
      'We are a software development company offering custom software development services and solutions. ' +
      'Our voice agents answer calls.';
    const profile = sourceProfile(source, text);
    const weight = buildTermWeights(source, [generic, specific]);
    const g = scoreTarget(profile, generic, weight);
    const s = scoreTarget(profile, specific, weight);
    // The generic page matches every word of its title, yet stays far below the specific one.
    expect(g.score).toBeLessThan(0.2);
    expect(s.score).toBeGreaterThan(g.score * 2);
    expect(['development', 'software', 'solution', 'company', 'service', 'technology'].every((t) => GENERIC_TERMS.has(t))).toBe(true);
  });

  it('is deterministic (same input, same output and order)', () => {
    const site = makeSiteFixture();
    const pool = [site.unrelated, site.crm, site.dental, site.voice];
    const a = rankTargets(site.source, SOURCE_TEXT, pool);
    const b = rankTargets(site.source, SOURCE_TEXT, [...pool].reverse());
    expect(a.map((r) => [r.page.url, r.score, r.signals])).toEqual(b.map((r) => [r.page.url, r.score, r.signals]));
    expect(a.at(-1).page.url).toBe(site.unrelated.url);
  });

  it('ties are broken by URL', () => {
    const src = makePage('/src/', { title: 'Source' });
    const x = makePage('/b-page/', { title: 'Nothing shared' });
    const y = makePage('/a-page/', { title: 'Nothing shared' });
    const ranked = rankTargets(src, 'unrelated text only here', [x, y]);
    expect(ranked.map((r) => r.page.url)).toEqual([y.url, x.url]);
  });

  it('coverage requires minimum evidence', () => {
    const flat = () => 0.1;
    expect(coverage(new Set(['software']), new Set(['software']), flat)).toBeCloseTo(0.1 / MIN_EVIDENCE);
    expect(coverage(new Set(['chatbot']), new Set(['chatbot']))).toBe(1);
    expect(coverage(new Set(), new Set(['x']))).toBe(0);
    expect(coverage(new Set(['a1', 'b1']), new Set(['a1']))).toBe(0.5);
  });

  it('overlap is weighted Jaccard', () => {
    expect(overlap(tokenSet('voice agents chatbot'), tokenSet('voice agents chatbot'))).toBe(1);
    expect(overlap(tokenSet('voice agents'), tokenSet('bakery recipes'))).toBe(0);
    expect(overlap(new Set(), tokenSet('x'))).toBe(0);
  });

  it('region/language and quality signals', () => {
    const base = { language: 'en', region: 'us' };
    expect(regionLanguageSignal(base, { language: 'en-US', region: 'US' })).toBe(1);
    expect(regionLanguageSignal(base, { language: null, region: null })).toBe(0.75);
    expect(regionLanguageSignal(base, { language: 'en', region: 'in' })).toBe(0.5);
    expect(qualitySignal({ title: 'T', h1: 'H', meta_description: 'M', keywords: ['k'] })).toBe(1);
    expect(qualitySignal({ title: ' ', h1: null, meta_description: null, keywords: [] })).toBe(0);
  });

  it('IDF damps terms shared by every page (e.g. the brand)', () => {
    const src = makePage('/s/', { title: 'Acme Voice Agents' });
    const pages = [1, 2, 3, 4].map((i) => makePage(`/p${i}/`, { title: `Acme topic${i}` }));
    const weight = buildTermWeights(src, pages);
    expect(weight('acme')).toBeLessThan(weight('topic1'));
    expect(weight('software')).toBeLessThan(0.11);
  });

  it('topSignals explains the strongest topical signals only', () => {
    const top = topSignals({ content_title: 0.9, phrase_overlap: 0.5, quality: 1, region_language: 1, h1_overlap: 0 });
    expect(top).toEqual([
      ['content_title', 0.9],
      ['phrase_overlap', 0.5],
    ]);
  });
});
