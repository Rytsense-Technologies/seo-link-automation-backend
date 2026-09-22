# Node.js migration plan

The Python/FastAPI backend in `app/` is the **behavioural reference** (see `REFERENCE_PYTHON.md`).
The Node.js implementation lives alongside it in `src/` and `test/`. Nothing in `app/`, `tests/`
or `alembic/` is modified.

## 1. Feature inventory (from the Python code)

| Area | Python module | Node module |
|---|---|---|
| Settings (env / `.env`, validated ranges) | `app/core/config.py` | `src/config/config.js` |
| Error envelope, 404/409/422/502/503 mapping | `app/core/exceptions.py` | `src/utils/errors.js` |
| Optional API key (`X-API-Key`, constant-time) | `app/core/security.py` | `src/plugins/auth.js` |
| URL helpers (`normalize_url`, `url_key`, …) | `app/core/urls.py` | `src/utils/urls.js` (+ `src/utils/pyurl.js`) |
| DB engine / session / ping | `app/db/session.py` | `src/db/pool.js` |
| AI providers (Gemini, OpenAI, Groq, none) | `app/ai/*` | `src/interlink/{provider,gemini,openai,groq}.js` |
| Position-preserving HTML tokenizer | `app/content/html.py` | `src/content/html.js` |
| Content store (optimistic `content_version`) | `app/content/store.py` | `src/content/store.js` |
| Sites & pages inventory | `app/pages/*` | `src/routes/{sites,pages}.js`, `src/db/queries/pages.js` |
| Crawler (robots, sitemaps, fetch, extract, SSRF, store) | `app/crawler/*` | `src/crawler/*` |
| Interlink (filter, retrieve, AI, validate, review, apply) | `app/interlink/*` | `src/interlink/*` |

## 2. API endpoints (FastAPI routes → Fastify routes, same paths/methods/status codes)

| Method | Path | Success | Notes |
|---|---|---|---|
| GET | `/health` | 200 `{"status":"ok"}` | no auth |
| GET | `/health/db` | 200 `{"status":"ok","database":"ok"}` | 503 `DATABASE_ERROR` if DB down |
| POST | `/api/sites` | **201** SiteRead | 409 `CONFLICT` duplicate base_url |
| GET | `/api/sites` | 200 SiteRead[] | ordered by created_at |
| PUT | `/api/sites/{site_id}/pages` | 200 `{upserted,page_ids}` | 404 `SITE_NOT_FOUND`, 422 `INVALID_PAGE_URL` |
| GET | `/api/pages` | 200 `{items,total,page,page_size}` | `site_id`, `page>=1`, `1<=page_size<=200` (default 50) |
| GET | `/api/pages/{page_id}` | 200 PageDetail | 404 `PAGE_NOT_FOUND` |
| POST | `/api/sites/{site_id}/crawl` | 200 CrawlResponse | body optional; 404/409 `CRAWL_IN_PROGRESS`/422 |
| POST | `/api/interlink/analyze` | 200 AnalyzeResponse | 404/422/502/503 |
| GET | `/api/interlink/suggestions` | 200 `{items,total,page,page_size}` | status/site/source/target/min score, `1<=page_size<=100` (default 20) |
| GET | `/api/interlink/suggestions/{id}` | 200 SuggestionDetail | 404 `SUGGESTION_NOT_FOUND` |
| POST | `/api/interlink/suggestions/{id}/approve` | 200 SuggestionDetail | 409 `INVALID_STATUS_TRANSITION` / `ACTIVE_SUGGESTION_EXISTS` |
| POST | `/api/interlink/suggestions/{id}/reject` | 200 SuggestionDetail | optional body `{"reason"}` (≤2000) |
| POST | `/api/interlink/suggestions/{id}/apply` | 200 SuggestionDetail | 409/422 codes as Python |
| GET | `/docs`, `/docs/json` (+ alias `/openapi.json`) | Swagger UI / OpenAPI | FastAPI served `/docs` + `/openapi.json` |

Error envelope everywhere: `{"error":{"code","message","details"}}`; validation → 422
`VALIDATION_ERROR` with `details.errors`; unknown route → `HTTP_ERROR`; DB failure → 503
`DATABASE_ERROR` (`"A database error occurred"`); API key → 401 `UNAUTHORIZED`.

## 3. Database (unchanged; Alembic revision `20260922_0001`)

- `sites(id uuid pk, name varchar255, base_url varchar2048 unique, default_language, default_region, created_at, updated_at)`
- `pages(... url varchar2048, content_html text, content_version int default 1, canonical_url, http_status (indexed), redirect_url, is_indexable bool default true, has_noindex bool default false, language, region, page_type, keywords text[], outgoing_links text[], last_crawled_at, created_at, updated_at)`;
  `uq_pages_site_id_url`, `ix_pages_site_id`, `ix_pages_http_status`, FK `site_id → sites ON DELETE CASCADE`.
- `internal_link_suggestions(...)` with enum `interlink_suggestion_status`, checks
  `relevance_score BETWEEN 0 AND 100` and `source_page_id <> target_page_id`, FKs CASCADE,
  indexes on site/source/target, `(status, relevance_score)`, and the partial unique index
  `uq_internal_link_suggestions_active_pair … WHERE status IN ('PENDING','APPROVED','APPLIED')`.
- UUIDs and timestamps are generated as Python did (ids in the application, `now()` defaults in DB,
  `updated_at` bumped on UPDATE — done explicitly in SQL since there is no ORM `onupdate`).
- Node never alters the schema of an existing DB. `npm run db:migrate` only applies the same
  DDL (rendered from the Alembic migration) to an **empty** database and records
  `alembic_version = 20260922_0001`, so both stacks stay interchangeable.

## 4. Crawler behaviour to preserve

robots.txt (RFC 9309 groups, product-token match, longest rule wins, Allow wins ties, `*`/`$`,
percent-decoded comparison, 4xx=allow all, 5xx/unreachable/off-site redirect=disallow all,
`Crawl-delay` capped) · sitemaps (robots-declared else `/sitemap.xml`, index recursion,
`max_sitemaps`, gzip with decompression cap, plain text, DTD/ENTITY rejection, strict XML,
off-scope sitemaps reported) · URL normalisation (Python `urljoin`/`urlsplit` semantics,
fragments, default ports, duplicate slashes, tracking params, sorted query, `quote_plus`
re-encoding, trailing-slash-insensitive `url_key`) · assets/traps · BFS with discovery cap ·
politeness delay · retries (429/5xx/transport, `Retry-After`) · response size cap · manual
redirects with per-hop validation · redirect hop pages stored with `redirect_url` · 4xx/5xx only
update status of existing pages · duplicate final URL skip · HTML extraction (main-content root,
chrome stripping, headings, noindex meta/header, canonical, lang, keywords, links vs content
links, nofollow) · Next.js `NEXT_REDIRECT` digest + meta refresh (unsafe schemes rejected,
normalised, SSRF-checked, scope-checked, queued) · unusable-page detection · advisory lock
`CRAWL_IN_PROGRESS` · counters (`html_redirects`, `unusable_pages`, skip reasons, 200-error cap).

## 5. Security rules to preserve

SSRF: http/https only; ports 80/443 (configurable); no URL credentials; blocked hostnames
(localhost, metadata names, `.localhost/.local/.internal/.localdomain/.home.arpa`); literal and
**resolved** IPs must be globally routable (private, loopback, link-local incl. 169.254.169.254,
CGNAT, multicast, reserved, unspecified, documentation, IPv4-mapped IPv6); **every** DNS answer
must be public; the socket connects to the validated IP (DNS-rebinding safe, enforced in the
connection layer for every request/redirect hop); TLS verifies the real hostname; no proxy env.
API key constant-time compare. Parameterised SQL only. Secrets only from env.

## 6. Test inventory (Python → Vitest)

`tests/unit`: urls, ai_providers, anchor_rules, candidate_filter, candidate_retriever,
link_applier, relevance_analyzer, service_analyze, service_review_apply, crawler_urls,
crawler_ssrf, crawler_robots, crawler_sitemap, crawler_extract, crawler_service,
crawler_html_redirects. `tests/api`: interlink_api, crawler_api. `tests/integration`
(PostgreSQL, `TEST_DATABASE_URL`): postgres, crawler_postgres. Each is ported 1:1 to
`test/unit`, `test/api`, `test/integration` (same fixtures, fakes, mock website).

## 7. Checklist

- [x] Inspect the complete Python backend, inventory endpoints/tables/behaviour/security/tests
- [x] Branch `node-js-migration`; Python files fingerprinted, never modified
- [x] Node project: package.json, ESLint, Vitest, `.env` loading
- [x] Core: config, errors, API key, URL helpers (Python-compatible), logging, DB pool
- [x] Content tokenizer + content store
- [x] Pages/sites routes + queries
- [x] Crawler: urls, ssrf (connect-time guard), fetcher, robots, sitemap, html-redirects, extract, store, service
- [x] Interlink: text features, filter, retriever, anchor rules, analyzer, providers, applier, repository, service, routes
- [x] Swagger `/docs`, `/docs/json`, `/openapi.json`
- [x] Port every Python test; run `npm test`, `npm run lint`, `npm run test:integration`
- [x] Start server, verify `/docs` and endpoints against the dev DB (read-only calls)
- [x] Request validation/parsing with Pydantic + CPython json semantics; side-by-side HTTP parity check with the Python server
- [x] README, NODE_MIGRATION_NOTES.md
- [ ] Production smoke crawls (25 / 200 pages) — **manual, only after approval**
