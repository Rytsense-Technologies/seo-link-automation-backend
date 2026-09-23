/**
 * Default dependency wiring (the FastAPI `Depends` graph). Every entry is a factory so tests can
 * override any of them via `buildApp({ deps })`, like `app.dependency_overrides`:
 *   - `pool`       -> the pg Pool (Python `get_db`)
 *   - `aiProvider` -> the AI provider (Python `get_ai_provider`)
 * Factories resolve their own dependencies through `deps()`, so overriding `pool` or `aiProvider`
 * reaches every service built from them.
 */

import { getPool, pingDatabase } from '../db/pool.js';
import { PageService } from '../db/queries/pages.js';
import { DatabaseContentStore } from '../content/store.js';
import { buildSiteCrawler, createGuardedFetch } from '../crawler/dependencies.js';
import { LexicalCandidateRetriever } from '../interlink/candidate-retriever.js';
import { getAiProvider, getFallbackAiProvider } from '../interlink/provider.js';
import { FallbackRelevanceAnalyzer, RelevanceAnalyzer } from '../interlink/relevance-analyzer.js';
import { PgInterlinkRepository, PgSession } from '../interlink/repository.js';
import { InterlinkService, interlinkConfigFromSettings } from '../interlink/service.js';

/**
 * @param getSettings () => settings
 * @param deps        () => the merged dependency object (defaults + overrides)
 */
export function defaultDeps(getSettings, deps) {
  return {
    pool: () => getPool(),
    aiProvider: async () => getAiProvider(getSettings()),
    /** Optional secondary provider (AI_FALLBACK_PROVIDER); null when not configured. */
    aiFallbackProvider: async () => getFallbackAiProvider(getSettings()),
    pingDatabase: () => pingDatabase(deps().pool()),
    pageService: () => new PageService(deps().pool()),
    siteCrawler: () => {
      const settings = getSettings();
      const fetchImpl = createGuardedFetch(settings);
      return { crawler: buildSiteCrawler(settings, { pool: deps().pool(), fetchImpl }), close: () => fetchImpl.close() };
    },
    interlinkService: async () => {
      const settings = getSettings();
      const session = new PgSession(deps().pool());
      const service = new InterlinkService(new PgInterlinkRepository(session), {
        config: interlinkConfigFromSettings(settings),
        retriever: new LexicalCandidateRetriever(),
        analyzerFactory: async () => {
          const limits = {
            sourceContentMaxChars: settings.interlink_source_content_max_chars,
            targetExcerptChars: settings.interlink_target_excerpt_chars,
          };
          const secondary = await deps().aiFallbackProvider();
          let primary;
          try {
            primary = await deps().aiProvider();
          } catch (err) {
            // No primary configured: use the secondary alone rather than failing.
            if (secondary === null) throw err;
            return new RelevanceAnalyzer(secondary, limits);
          }
          const analyzer = new RelevanceAnalyzer(primary, limits);
          return secondary === null
            ? analyzer
            : new FallbackRelevanceAnalyzer([analyzer, new RelevanceAnalyzer(secondary, limits)]);
        },
        contentStore: new DatabaseContentStore(session),
      });
      return { service, close: () => session.close() };
    },
  };
}
