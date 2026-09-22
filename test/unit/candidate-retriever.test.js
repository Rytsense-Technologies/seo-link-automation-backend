// Port of tests/unit/test_candidate_retriever.py
import { beforeEach, describe, expect, it } from 'vitest';
import { extractBlocks } from '../../src/content/html.js';
import { filterCandidates } from '../../src/interlink/candidate-filter.js';
import { LexicalCandidateRetriever } from '../../src/interlink/candidate-retriever.js';
import { tokenize } from '../../src/interlink/text-features.js';
import { defaultConfig, makePage, makeSiteFixture } from '../helpers/fakes.js';

describe('candidate retriever', () => {
  let site;
  beforeEach(() => {
    site = makeSiteFixture();
  });
  const eligible = async () => filterCandidates(site.source, await site.repo.listCandidatePool(site.source), defaultConfig().filters).accepted;

  it('ranks topically related pages first', async () => {
    const text = extractBlocks(site.source.content_html ?? '', { linkContextsOnly: true }).join('\n');
    const results = new LexicalCandidateRetriever().retrieve(site.source, text, await eligible(), 10);
    const urls = results.map((c) => c.page.url);
    expect(urls[0]).toBe(site.voice.url);
    expect(urls).toContain(site.crm.url);
    expect(urls).toContain(site.dental.url);
    // Unrelated content scores zero and is not returned.
    expect(urls).not.toContain(site.unrelated.url);
    expect(results.every((c) => c.score > 0 && c.score <= 1)).toBe(true);
    expect(results).toEqual([...results].sort((a, b) => b.score - a.score));
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) => makePage(`/voice-agent-${i}/`, { title: `AI voice agent use case ${i}` }));
    const results = new LexicalCandidateRetriever().retrieve(site.source, 'AI voice agents for customer support', many, 15);
    expect(results).toHaveLength(15);
  });

  it('handles no eligible pages', () => {
    expect(new LexicalCandidateRetriever().retrieve(site.source, 'anything', [], 10)).toEqual([]);
  });

  it('tokenizer folds plurals and drops stopwords', () => {
    expect(tokenize('The AI Voice Agents and companies')).toEqual(['ai', 'voice', 'agent', 'company']);
  });
});
