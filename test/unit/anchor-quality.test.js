// Phase 2.1: anchor quality and its effect on ranking.
// Behaviour is asserted as relations ("meaningful > generic"), not as fixed numbers.
import { describe, expect, it } from 'vitest';
import {
  ANCHOR_EVIDENCE,
  SIGNAL_WEIGHTS,
  anchorQualitySignal,
  buildTermWeights,
  scoreTarget,
  sourceMentions,
  sourceProfile,
} from '../../src/interlink/relevance-scorer.js';
import { findPlacements, rankPlacements, splitSentences } from '../../src/interlink/deterministic-suggester.js';
import { makePage } from '../helpers/fakes.js';

const SOURCE_TEXT = [
  'With extensive experience in AI chatbot development, we create digital assistants that feel natural.',
  'As an experienced AI chatbot development company, we design conversational AI systems for support teams.',
  'Enhance your brand presence with tailor-made AI chatbots and chatbot development services.',
  'We also handle appointment booking, scheduling and machine learning projects for enterprise clients.',
  'Our assistants support booking and scheduling for clients across every channel.',
].join('\n');

const source = () => makePage('/ai-chatbot-development-services/', { title: 'AI Chatbot Development Services', h1: 'AI Chatbots' });

// Real pages the anchors name; no anchor text or URL is special-cased in the algorithm.
const TARGETS = {
  booking: makePage('/ai-appointment-booking/', { title: 'AI Appointment Booking Software', h1: 'AI Appointment Booking' }),
  assistants: makePage('/blog/smart-digital-assistants-business-operations/', {
    title: 'Smart Digital Assistants for Business Operations',
    h1: 'Smart Digital Assistants',
  }),
  scheduling: makePage('/us/appointment-scheduling-automation/', {
    title: 'Appointment Scheduling Automation',
    h1: 'Appointment Scheduling Automation',
  }),
  machineLearning: makePage('/us/blog/most-trusted-machine-learning-solutions/', {
    title: 'Most Trusted Machine Learning Solutions',
    h1: 'Machine Learning Solutions',
  }),
  chatbotDevelopment: makePage('/blog/ai-chatbot-development-service-for-websites/', {
    title: 'AI Chatbot Development Service for Websites',
    h1: 'Chatbot Development',
  }),
  conversationalAi: makePage('/blog/use-cases-of-conversational-ai-for-healthcare/', {
    title: 'Use Cases of Conversational AI for Healthcare',
    h1: 'Conversational AI',
  }),
  aiChatbotDevelopment: makePage('/blog/enterprise-ai-chatbot-development-cost/', {
    title: 'Enterprise AI Chatbot Development Cost',
    h1: 'AI Chatbot Development',
  }),
  aiChatbots: makePage('/blog/use-cases-of-ai-chatbots-in-business/', { title: 'Use Cases of AI Chatbots in Business', h1: 'AI Chatbots' }),
  software: makePage('/software-development-company/', { title: 'Software Development Company', h1: 'Custom Software Development' }),
};

function quality(anchor, target, pool = Object.values(TARGETS)) {
  const src = source();
  return anchorQualitySignal(anchor, target, sourceProfile(src, SOURCE_TEXT), buildTermWeights(src, pool));
}

describe('anchor_quality', () => {
  const strong = [
    ['Machine Learning', TARGETS.machineLearning],
    ['chatbot development', TARGETS.chatbotDevelopment],
    ['conversational AI', TARGETS.conversationalAi],
    ['AI chatbot development', TARGETS.aiChatbotDevelopment],
    ['AI chatbots', TARGETS.aiChatbots],
  ];
  const weak = [
    ['booking', TARGETS.booking],
    ['assistants', TARGETS.assistants],
    ['scheduling', TARGETS.scheduling],
  ];

  it('rates every meaningful phrase above every generic single-word anchor', () => {
    const weakest = Math.min(...strong.map(([a, t]) => quality(a, t)));
    const strongest = Math.max(...weak.map(([a, t]) => quality(a, t)));
    expect(weakest).toBeGreaterThan(strongest);
  });

  it.each(strong)('rates "%s" above every generic single-word anchor', (anchor, target) => {
    const value = quality(anchor, target);
    expect(value).toBeLessThanOrEqual(1);
    for (const [weakAnchor, weakTarget] of weak) expect(value).toBeGreaterThan(quality(weakAnchor, weakTarget));
  });

  it.each(weak)('keeps "%s" usable but never preferred', (anchor, target) => {
    const value = quality(anchor, target);
    expect(value).toBeGreaterThan(0); // still valid, just outranked
    for (const [strongAnchor, strongTarget] of strong) expect(value).toBeLessThan(quality(strongAnchor, strongTarget));
  });

  it('is not a word count: a specific single word beats a generic phrase', () => {
    const chatbots = makePage('/chatbots/', { title: 'Chatbots', h1: 'Chatbots' });
    expect(quality('chatbots', chatbots)).toBeGreaterThan(quality('software development company', TARGETS.software));
  });

  it('judges the whole phrase, so generic words are a penalty and not a rejection', () => {
    // "software" alone is near-worthless; qualifying it raises the phrase.
    const single = quality('software', TARGETS.software);
    const compound = quality('custom software development', TARGETS.software);
    expect(compound).toBeGreaterThan(single);
    // A generic head with a specific qualifier is strong.
    expect(quality('AI appointment booking', TARGETS.booking)).toBeGreaterThan(quality('booking', TARGETS.booking));
    expect(quality('AI chatbot development', TARGETS.aiChatbotDevelopment)).toBeGreaterThan(
      quality('chatbot development', TARGETS.chatbotDevelopment),
    );
  });

  it('rewards an anchor that names a whole field of the target identity', () => {
    // "assistants" is a fragment of "Smart Digital Assistants"; the full phrase names the page.
    expect(quality('smart digital assistants', TARGETS.assistants)).toBeGreaterThan(quality('assistants', TARGETS.assistants));
  });

  it('rewards phrases the source actually repeats', () => {
    const src = source();
    const weight = buildTermWeights(src, Object.values(TARGETS));
    const repeated = sourceProfile(src, `${SOURCE_TEXT}\nAI chatbot development again and again in AI chatbot development projects.`);
    const once = sourceProfile(src, 'We mention AI chatbot development exactly once here today.');
    expect(anchorQualitySignal('AI chatbot development', TARGETS.aiChatbotDevelopment, repeated, weight)).toBeGreaterThan(
      anchorQualitySignal('AI chatbot development', TARGETS.aiChatbotDevelopment, once, weight),
    );
  });

  it('penalises an anchor that matches only a slogan H1', () => {
    // A page is known by its title and URL; "Transform Your Business" as an H1 does not make
    // "transform" a useful anchor for a case-studies page.
    const slogan = makePage('/us/case-studies/', { title: 'AI Case Studies - US Clients', h1: 'Transform Your Business' });
    const named = makePage('/us/case-studies/', { title: 'AI Case Studies - US Clients', h1: 'AI Case Studies' });
    const text = 'We transform support desks with chatbots. Our case studies transform how teams work.';
    const src = source();
    const profile = sourceProfile(src, text);
    const weight = buildTermWeights(src, [slogan, named]);
    expect(anchorQualitySignal('transform', slogan, profile, weight)).toBeLessThan(
      anchorQualitySignal('case studies', named, profile, weight),
    );
    // The same anchor is worth more when the title/slug actually contain it.
    const inTitle = makePage('/transformation/', { title: 'Business Transform Services', h1: 'Transform Your Business' });
    expect(anchorQualitySignal('transform', inTitle, profile, weight)).toBeGreaterThan(
      anchorQualitySignal('transform', slogan, profile, weight),
    );
  });

  it('is 0 for an empty or stopword-only anchor', () => {
    expect(quality('', TARGETS.aiChatbots)).toBe(0);
    expect(quality('of the', TARGETS.aiChatbots)).toBe(0);
  });

  it('counts source mentions of the exact phrase', () => {
    const profile = sourceProfile(source(), SOURCE_TEXT);
    expect(sourceMentions(profile, 'AI chatbot development')).toBe(2);
    expect(sourceMentions(profile, 'conversational AI')).toBe(1);
    expect(sourceMentions(profile, 'quantum computing')).toBe(0);
    expect(sourceMentions(profile, 'of the')).toBe(0);
    expect(ANCHOR_EVIDENCE).toBeGreaterThan(0);
  });

  it('ranks placements by anchor quality, deterministically', () => {
    const src = source();
    const profile = sourceProfile(src, SOURCE_TEXT);
    const weight = buildTermWeights(src, Object.values(TARGETS));
    const sentences = splitSentences(SOURCE_TEXT.replaceAll('\n', ' '));
    const placements = findPlacements(TARGETS.aiChatbotDevelopment, sentences, weight);
    const ranked = rankPlacements(placements, TARGETS.aiChatbotDevelopment, profile, weight);
    expect(ranked.length).toBeGreaterThan(1);
    // The fullest phrase wins: a shorter substring must not win on mention count alone.
    expect(ranked[0].anchor.toLowerCase()).toBe('ai chatbot development');
    for (let i = 1; i < ranked.length; i += 1) expect(ranked[i - 1].anchor_quality).toBeGreaterThanOrEqual(ranked[i].anchor_quality);
    expect(rankPlacements(placements, TARGETS.aiChatbotDevelopment, profile, weight)).toEqual(ranked);
  });
});

describe('anchor quality inside the score', () => {
  it('is a weighted signal like any other, and the weights still sum to 1', () => {
    expect(Object.values(SIGNAL_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(SIGNAL_WEIGHTS.anchor_quality).toBeGreaterThan(SIGNAL_WEIGHTS.slug_similarity);
    const src = source();
    const profile = sourceProfile(src, SOURCE_TEXT);
    const weight = buildTermWeights(src, Object.values(TARGETS));
    const withAnchor = scoreTarget(profile, TARGETS.aiChatbots, weight, { anchorQuality: 0.9 });
    const without = scoreTarget(profile, TARGETS.aiChatbots, weight);
    expect(withAnchor.score).toBeGreaterThan(without.score);
    expect(without.signals.anchor_quality).toBe(0);
    expect(withAnchor.signals.anchor_quality).toBe(0.9);
  });

  it('a contextual phrase outranks a target that only matches the slug', () => {
    const src = makePage('/ai-chatbot-development-services/', { title: 'AI Chatbot Development Services', h1: 'AI Chatbots' });
    const text = 'Our team builds conversational AI for support desks. Conversational AI keeps customers served around the clock.';
    const profile = sourceProfile(src, text);
    // Slug echoes the source topic, but the body copy offers no phrase naming it.
    const slugOnly = makePage('/ai-chatbot-development-services-pricing/', { title: 'Pricing Table', h1: 'Pricing' });
    const contextual = makePage('/blog/conversational-ai-guide/', { title: 'Conversational AI Guide', h1: 'Conversational AI' });
    const weight = buildTermWeights(src, [slugOnly, contextual]);
    const slugScore = scoreTarget(profile, slugOnly, weight).score;
    const contextualScore = scoreTarget(profile, contextual, weight, { anchorQuality: quality('conversational AI', contextual, [slugOnly, contextual]) }).score;
    expect(contextualScore).toBeGreaterThan(slugScore);
  });

  it('slug similarity alone cannot dominate the score', () => {
    const src = makePage('/ai-voice-agents/', { title: 'AI Voice Agents', h1: 'AI Voice Agents' });
    const profile = sourceProfile(src, 'We ship reliable telephony software for busy teams every single week.');
    const slugTwin = makePage('/ai-voice-agents-overview/', { title: 'Overview', h1: 'Overview' });
    const weight = buildTermWeights(src, [slugTwin]);
    const { score, signals } = scoreTarget(profile, slugTwin, weight);
    expect(signals.slug_similarity).toBeGreaterThan(0.5);
    // With no anchor and no contextual overlap, a strong slug stays a minor contribution.
    expect(score).toBeLessThan(0.35);
  });
});
