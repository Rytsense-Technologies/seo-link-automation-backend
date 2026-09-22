// Port of tests/unit/test_anchor_rules.py
import { describe, expect, it } from 'vitest';
import { anchorProblem, containsPhrase } from '../../src/interlink/anchor-rules.js';

const CONTEXT = 'Businesses can use AI voice agents to automate repetitive customer support.';

describe('anchor rules', () => {
  it.each(['AI voice agents', 'customer support', 'ai VOICE agents'])('valid anchor %s', (anchor) => {
    expect(anchorProblem(anchor, CONTEXT)).toBeNull();
  });

  it.each([
    ['click here', 'For details click here.', 'ANCHOR_GENERIC'],
    ['Read more', 'Read more about it.', 'ANCHOR_GENERIC'],
    ['!!!', CONTEXT, 'ANCHOR_EMPTY'],
    ['can use', CONTEXT, 'ANCHOR_NOT_DESCRIPTIVE'],
    [
      'use AI voice agents to automate repetitive customer support now',
      'We use AI voice agents to automate repetitive customer support now.',
      'ANCHOR_TOO_LONG',
    ],
    ['voice agents voice agents', 'Try voice agents voice agents today.', 'ANCHOR_KEYWORD_STUFFING'],
    ['chatbot platform', CONTEXT, 'ANCHOR_NOT_IN_CONTEXT'],
    ['voice agent', CONTEXT, 'ANCHOR_NOT_IN_CONTEXT'], // partial word "agents"
  ])('invalid anchor %s -> %s', (anchor, context, code) => {
    expect(anchorProblem(anchor, context)).toBe(code);
  });

  it('contains_phrase is whitespace, quote and case insensitive', () => {
    expect(containsPhrase('It’s   a  Smart\nChoice', "it's a smart choice")).toBe(true);
    expect(containsPhrase('automation', 'auto')).toBe(false);
  });
});
