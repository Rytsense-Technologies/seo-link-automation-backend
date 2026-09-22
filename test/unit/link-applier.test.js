// Port of tests/unit/test_link_applier.py — context scoping, existing-link detection, unsafe HTML.
import { describe, expect, it } from 'vitest';
import { extractBlocks, parseHtml } from '../../src/content/html.js';
import { LinkApplicationError, applyLink, containsLinkTo } from '../../src/interlink/apply.js';

const PAGE = 'https://www.example.com/source/';
const TARGET = 'https://www.example.com/ai-voice-agent/';

const apply = (content, { anchor = 'AI voice agents', context = null } = {}) =>
  applyLink(content, {
    pageUrl: PAGE,
    targetUrl: TARGET,
    href: '/ai-voice-agent/',
    anchorText: anchor,
    context: context || 'Businesses can use AI voice agents to automate support.',
  }).content;

function errorCode(content, options) {
  try {
    apply(content, options);
  } catch (err) {
    expect(err).toBeInstanceOf(LinkApplicationError);
    return err.code;
  }
  throw new Error('expected LinkApplicationError');
}

const count = (s, needle) => s.split(needle).length - 1;

describe('link applier', () => {
  it('links only the occurrence inside the context', () => {
    const html =
      '<p>AI voice agents are popular.</p>\n' +
      '<p>Businesses can use AI voice agents to automate support.</p>\n' +
      '<p>More AI voice agents.</p>';
    const result = apply(html);
    expect(result).toBe(
      '<p>AI voice agents are popular.</p>\n' +
        '<p>Businesses can use <a href="/ai-voice-agent/">AI voice agents</a> to automate support.</p>\n' +
        '<p>More AI voice agents.</p>',
    );
    expect(count(result, '<a ')).toBe(1);
  });

  it('preserves original formatting and casing', () => {
    const html = '<div class="x">\n  <p>Businesses   can use ai Voice AGENTS\n to automate support.</p>\n</div>';
    const result = apply(html);
    expect(result).toContain('<a href="/ai-voice-agent/">ai Voice AGENTS</a>');
    expect(result.replace('<a href="/ai-voice-agent/">', '').replace('</a>', '')).toBe(html);
  });

  it('handles entities and inline markup in the context', () => {
    const html = '<p>Businesses can use <strong>AI voice agents</strong> to automate&nbsp;support.</p>';
    expect(apply(html)).toContain('<strong><a href="/ai-voice-agent/">AI voice agents</a></strong>');
  });

  it('detects existing links', () => {
    const html = '<p>Businesses can use AI voice agents to automate support. <a href="/ai-voice-agent">x</a></p>';
    expect(containsLinkTo(html, PAGE, TARGET)).toBe(true);
    expect(errorCode(html)).toBe('ALREADY_LINKED');
    const absolute = '<p><a href="https://example.com/ai-voice-agent/#pricing">y</a></p>';
    expect(containsLinkTo(absolute, PAGE, TARGET)).toBe(true);
  });

  it('never nests links', () => {
    const html = '<p>Businesses can use <a href="/other/">AI voice agents</a> to automate support.</p>';
    expect(errorCode(html)).toBe('ANCHOR_IN_UNSAFE_ELEMENT');
  });

  it('skips an occurrence inside a link and uses the safe one in the same context', () => {
    const html = '<p>Businesses can use <a href="/x/">AI voice agents</a> and AI voice agents to automate support.</p>';
    const result = apply(html, { context: 'Businesses can use AI voice agents and AI voice agents to automate support.' });
    expect(result).toContain('<a href="/x/">AI voice agents</a> and <a href="/ai-voice-agent/">AI voice agents</a>');
  });

  it.each([
    '<script>{}</script>',
    '<style>{}</style>',
    '<h2>{}</h2>',
    '<nav><p>{}</p></nav>',
    '<footer><p>{}</p></footer>',
    '<pre>{}</pre>',
    '<button>{}</button>',
    '<textarea>{}</textarea>',
    '<!-- {} -->',
  ])('never links inside unsafe element %s', (wrapper) => {
    const sentence = 'Businesses can use AI voice agents to automate support.';
    expect(['CONTEXT_NOT_FOUND', 'ANCHOR_IN_UNSAFE_ELEMENT']).toContain(errorCode(wrapper.replace('{}', sentence)));
  });

  it('rejects an anchor spanning tags', () => {
    expect(errorCode('<p>Businesses can use AI <em>voice</em> agents to automate support.</p>')).toBe('ANCHOR_IN_UNSAFE_ELEMENT');
  });

  it('reports missing context / anchor / content', () => {
    expect(errorCode('<p>Completely different text.</p>')).toBe('CONTEXT_NOT_FOUND');
    const html = '<p>Businesses can use AI voice agents to automate support.</p>';
    expect(errorCode(html, { anchor: 'chat bots' })).toBe('ANCHOR_NOT_FOUND');
    expect(errorCode('   ')).toBe('SOURCE_CONTENT_EMPTY');
  });

  it('does not match partial words', () => {
    const html = '<p>Businesses can use AI voice agents to automate support.</p>';
    expect(errorCode(html, { anchor: 'AI voice agent' })).toBe('ANCHOR_NOT_FOUND');
  });

  it('escapes the href', () => {
    const html = '<p>Businesses can use AI voice agents to automate support.</p>';
    const result = applyLink(html, {
      pageUrl: PAGE,
      targetUrl: TARGET,
      href: '/a?x=1&y="2"',
      anchorText: 'AI voice agents',
      context: 'Businesses can use AI voice agents to automate support.',
    }).content;
    expect(result).toContain('<a href="/a?x=1&amp;y=&quot;2&quot;">');
  });

  it('parser tracks blocks and invisible text', () => {
    const html =
      "<head><title>T</title></head><body><h1>Head</h1><p>One <b>two</b></p><script>if (a < b) { x = '</p>' }</script><p>Three</p></body>";
    expect(extractBlocks(html)).toEqual(['Head', 'One two', 'Three']);
    expect(extractBlocks(html, { linkContextsOnly: true })).toEqual(['One two', 'Three']);
    expect(parseHtml('<a href="/x">x</a><a name="y">y</a>').anchors.map((a) => a.href)).toEqual(['/x']);
  });

  // Node-specific: lookbehind may see text before the context window (Python finditer(pos) semantics).
  it('whole-word check at the start of the context sees the preceding character', () => {
    // The context is found inside "xAI ..."; the anchor there is not a whole word, so Python
    // (re.finditer(text, pos, endpos)) reports ANCHOR_NOT_FOUND instead of linking "AI" in "xAI".
    const html = '<p>xAI voice agents are here. AI voice agents rock.</p>';
    expect(errorCode(html, { context: 'AI voice agents are here.' })).toBe('ANCHOR_NOT_FOUND');
  });
});
