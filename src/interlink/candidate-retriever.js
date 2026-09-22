/**
 * Candidate retrieval: narrow the site's eligible pages to a small pool for AI scoring
 * (app/interlink/candidate_retriever.py). A pgvector/embedding retriever can implement the same
 * `retrieve(source, sourceText, eligible, limit)` interface and be wired in `dependencies.js`.
 */

import { urlPath } from '../utils/urls.js';
import { pyCompare } from '../utils/pytext.js';
import { cosine, idf, tfidf, weightedTerms } from './text-features.js';

// Field weights: what a page is *about* is mostly in its title/H1/keywords/slug.
export const SOURCE_WEIGHTS = { title: 3.0, h1: 3.0, keywords: 3.0, meta: 1.5, content: 1.0 };
export const TARGET_WEIGHTS = { title: 3.0, h1: 3.0, keywords: 2.5, slug: 2.0, meta: 1.5 };

const slugText = (page) => urlPath(page.url).replaceAll('/', ' ').replaceAll('-', ' ').replaceAll('_', ' ');

/** Python `round(x, 4)` (exact decimal rounding of the binary value). */
const round4 = (x) => Number(x.toFixed(4));

/** TF-IDF cosine similarity over title, H1, keywords, slug and meta description. */
export class LexicalCandidateRetriever {
  constructor(minScore = 0.01) {
    this.minScore = minScore;
  }

  retrieve(source, sourceText, eligible, limit) {
    if (!eligible.length) return [];
    const sourceCounts = weightedTerms([
      [source.title, SOURCE_WEIGHTS.title],
      [source.h1, SOURCE_WEIGHTS.h1],
      [(source.keywords ?? []).join(' ; '), SOURCE_WEIGHTS.keywords],
      [source.meta_description, SOURCE_WEIGHTS.meta],
      [sourceText, SOURCE_WEIGHTS.content],
    ]);
    const targetCounts = eligible.map((page) =>
      weightedTerms([
        [page.title, TARGET_WEIGHTS.title],
        [page.h1, TARGET_WEIGHTS.h1],
        [(page.keywords ?? []).join(' ; '), TARGET_WEIGHTS.keywords],
        [slugText(page), TARGET_WEIGHTS.slug],
        [page.meta_description, TARGET_WEIGHTS.meta],
      ]),
    );
    const idfValues = idf([...targetCounts, sourceCounts]);
    const defaultIdf = idfValues.size ? Math.max(...idfValues.values()) : 1.0;
    const sourceVec = tfidf(sourceCounts, idfValues, defaultIdf);

    const scored = [];
    eligible.forEach((page, i) => {
      const score = cosine(sourceVec, tfidf(targetCounts[i], idfValues, defaultIdf));
      if (score >= this.minScore) scored.push({ page, score: round4(score) });
    });
    scored.sort((a, b) => b.score - a.score || pyCompare(a.page.url, b.page.url));
    return scored.slice(0, limit);
  }
}
