// Port of tests/unit/test_crawler_extract.py
import { describe, expect, it } from 'vitest';
import { extractPage } from '../../src/crawler/extract.js';

const URL = 'https://example.com/services/ai-voice-agent/';

const PAGE = `<!doctype html>
<html lang="en-US"><head>
<title> AI Voice Agent | Example </title>
<meta name="description" content="AI voice agents for customer support.">
<meta name="keywords" content="voice ai, call automation">
<link rel="canonical" href="/services/ai-voice-agent/?utm_source=x">
<script>var x = "tracking script text";</script>
<style>.hero { color: red }</style>
</head><body>
<header><nav><a href="/">Home</a><a href="/contact/">Contact</a></nav></header>
<div class="cookie-banner">We use cookies</div>
<main>
  <h1>AI Voice Agents</h1>
  <p>Our <a href="/services/crm-integration/">CRM integration</a> connects calls.</p>
  <!-- hidden comment text -->
  <h2>How it works</h2>
  <p>Agents answer calls <a href="mailto:a@b.c">email</a> <a href="tel:1">call</a>
     <a href="javascript:void(0)">js</a> <a href="https://twitter.com/x">tw</a>
     <a href="/pricing/" rel="nofollow">pricing</a>.</p>
  <aside>Related sidebar</aside>
  <form><input name="q"><button>Search</button></form>
  <script>inline main script</script>
</main>
<footer><a href="/privacy-policy/">Privacy</a> Footer text</footer>
</body></html>`;

describe('HTML extraction', () => {
  it('extracts metadata', () => {
    const page = extractPage(PAGE, URL);
    expect(page.title).toBe('AI Voice Agent | Example');
    expect(page.h1).toBe('AI Voice Agents');
    expect(page.metaDescription).toBe('AI voice agents for customer support.');
    expect(page.canonicalUrl).toBe(URL); // normalised: utm removed, made absolute
    expect(page.language).toBe('en-US');
    expect(page.keywords).toEqual(['voice ai', 'call automation']);
    expect(page.noindex).toBe(false);
    expect(page.headings).toEqual([
      ['h1', 'AI Voice Agents'],
      ['h2', 'How it works'],
    ]);
  });

  it('main content excludes chrome, scripts and widgets', () => {
    const page = extractPage(PAGE, URL);
    for (const unwanted of ['tracking script', 'color: red', 'Home', 'We use cookies', 'Footer text', 'Related sidebar', 'Search', 'inline main script', 'hidden comment']) {
      expect(page.contentText, unwanted).not.toContain(unwanted);
      expect(page.contentHtml, unwanted).not.toContain(unwanted);
    }
    expect(page.contentText).toContain('Our CRM integration connects calls.');
    expect(page.contentHtml).toContain('<a href="/services/crm-integration/">CRM integration</a>');
    expect(page.contentHash).toHaveLength(64);
  });

  it('all links vs content links', () => {
    const page = extractPage(PAGE, URL);
    expect(page.links).toContain('https://example.com/contact/'); // nav links used for discovery
    expect(page.links).toContain('https://example.com/privacy-policy/');
    expect(page.links).toContain('https://twitter.com/x'); // external: filtered later by scope
    expect(page.links.some((u) => /^(mailto|tel|javascript):/.test(u))).toBe(false);
    expect(page.links).not.toContain('https://example.com/pricing/'); // rel=nofollow
    expect(page.contentLinks).toEqual(['https://example.com/services/crm-integration/', 'https://twitter.com/x']);
  });

  it('noindex from meta or header', () => {
    expect(extractPage(PAGE.replace('<title>', '<meta name="robots" content="noindex, follow"><title>'), URL).noindex).toBe(true);
    expect(extractPage(PAGE.replace('<title>', '<meta name="ROBOTS" content="none"><title>'), URL).noindex).toBe(true);
    expect(extractPage(PAGE, URL, { xRobotsTag: 'noindex' }).noindex).toBe(true);
    expect(extractPage(PAGE, URL, { xRobotsTag: 'nofollow' }).noindex).toBe(false);
  });

  it('falls back to body and handles minimal pages', () => {
    const page = extractPage('<html><body><nav>menu</nav><p>Body copy only.</p><footer>f</footer></body></html>', URL);
    expect(page.contentText).toBe('Body copy only.');
    expect(page.title).toBeNull();
    expect(page.h1).toBeNull();
    expect(page.canonicalUrl).toBeNull();
    expect(extractPage('', URL).contentText).toBe('');
  });
});
