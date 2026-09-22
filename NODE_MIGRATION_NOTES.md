# Node.js migration notes

The Node.js backend (`src/`, `test/`) is a port of the Python/FastAPI backend (`app/`, `tests/`,
`alembic/`). The Python code is the behavioural reference and is **unchanged** (see
`REFERENCE_PYTHON.md`). This document records how the port maps to Python, what is identical,
what differs, and how that was verified.

Stack: Node ≥ 22, plain JavaScript (ES modules, no TypeScript), Fastify 5, `pg`, `@fastify/swagger`
+ `@fastify/swagger-ui`, Cheerio/htmlparser2, undici, pino, dotenv, Vitest, ESLint.

## 1. Module map

| Python | Node |
|---|---|
| `app/main.py` (app factory, error handlers) | `src/app.js`, `src/server.js` |
| `app/core/config.py` | `src/config/config.js` (same env names, defaults and range checks) |
| `app/core/exceptions.py` | `src/utils/errors.js` |
| `app/core/security.py` (API key) | `src/plugins/auth.js` |
| `app/core/urls.py` | `src/utils/urls.js`, `src/utils/pyurl.js` (port of CPython `urllib.parse`) |
| `app/core/logging.py` | `src/utils/logger.js` (pino) |
| `app/db/session.py` | `src/db/pool.js` |
| `alembic/versions/20260922_0001_*.py` | `src/db/migrations/20260922_0001_initial.{up,down}.sql` (rendered by `alembic upgrade --sql`), `src/db/migrate.js` |
| `app/pages/*` | `src/db/queries/pages.js`, `src/routes/{sites,pages}.js`, `src/schemas/pages.js` |
| `app/content/{html,store}.py` | `src/content/{html,store}.js` |
| `app/crawler/*` | `src/crawler/*` (`urls`, `ssrf`, `fetcher`, `robots`, `sitemap`, `dom`, `html-redirects`, `extract`, `store`, `service`, `dependencies`) |
| `app/ai/*` | `src/interlink/{provider,gemini,openai,groq}.js` |
| `app/interlink/*` | `src/interlink/*` (`text-features`, `anchor-rules`, `candidate-filter`, `candidate-retriever`, `relevance-analyzer`, `apply`, `repository`, `service`) |
| FastAPI `Depends` / `dependency_overrides` | `src/plugins/database.js` (`buildApp({ deps })` overrides, incl. `pool` and `aiProvider`) |
| FastAPI request validation (Pydantic) | `src/utils/request-validation.js`, `src/utils/pydantic.js`, `src/utils/pyjson.js` |
| Python str/Unicode semantics | `src/utils/pytext.js` (tables generated from CPython: `casefold`, `lower`, `isspace`, `isdigit`, `\w`) |

## 2. What is unchanged

- **Database**: same PostgreSQL schema, the same Alembic revision (`20260922_0001`), no new
  tables or columns. Node never alters an existing database. `npm run db:migrate` only
  initialises an *empty* database with the Alembic-rendered DDL and records the same
  `alembic_version`. Otherwise it is a no-op at head and refuses anything else. All SQL is
  parameterised.
- **API contract**: the same paths, methods, status codes, request/response fields, defaults and
  error envelope `{"error": {"code", "message", "details"}}`. Validation errors have FastAPI's
  `details.errors` shape, with Pydantic's `type`/`loc`/`msg`/`input`/`ctx`. Timestamps are
  rendered like Python `isoformat()`.
- **API key**: `X-API-Key` on `/api/*` only when `API_KEY` is set, compared in constant time and
  checked before validation (like the router dependency).
- **Crawler**: the same robots.txt rules (RFC 9309, longest match, Allow wins ties,
  4xx = allow all, 5xx = disallow all, capped Crawl-delay), sitemaps (index, gzip, plain text,
  size and decompression limits, no XML entities), URL normalisation (a port of
  `urllib.parse`), trap and asset detection, retries/backoff, the same redirect limits, the
  per-site advisory lock (`hashtextextended('crawl:'||id)`) and the same report fields.
- **SSRF**: the static checks are identical (the `ipaddress` tables are ported). The
  connect-time guard runs inside undici's connector and resolver: every resolved address must be
  public, and the socket only receives the validated IP, so DNS rebinding cannot bypass it. The
  port must be allowed, env proxies are ignored, and TLS SNI uses the real hostname. Every
  redirect hop is re-validated by `Fetcher`.
- **Next.js `NEXT_REDIRECT` shells, meta refresh, and empty/unusable 200 pages**: the same
  detection, the same follow rules (scope, robots, SSRF, loop bound) and the same storage
  (`redirect_url`, `is_indexable=false`), plus the interlink `EMPTY_CONTENT` exclusion.
- **Extraction**: BeautifulSoup-compatible text and `content_html` serialisation (sorted
  attributes, `<br/>`, the minimal formatter), so content hashes and `content_version` bumps
  match Python for the same page.
- **Interlink engine**: the same filters and exclusion reasons, TF-IDF retrieval (Python
  tokenisation, stopwords, Neumaier `sum`, round-half-even), prompt text, AI response
  validation, anchor rules, dedupe/cooldown, and the safe applier (position-preserving splice,
  unsafe elements, one link per suggestion, optimistic `content_version`).
- **AI providers**: Gemini, OpenAI and Groq via HTTP with JSON mode, and `none`, with the same
  errors (`AI_PROVIDER_ERROR` 502, `AI_NOT_CONFIGURED` 503). Tests never call a provider;
  providers are faked.
- **Routing edge cases (Starlette)**:
  - A known path with the wrong method returns 405, without an `Allow` header (the reference's
    handler drops it).
  - The trailing-slash toggle returns 307 with an absolute `Location`.
  - An empty path segment never matches `{param}`.
  - Everything else returns 404 `HTTP_ERROR`.
  - JSON responses use `content-type: application/json`.

### Request parsing and validation (why it is custom)

Ajv's coercion accepts and rejects different inputs than Pydantic. For example, it turns `5`
into `"5"` for a string field, wraps a scalar into a list, and turns `null` into `""`/`0`/`false`.
Pydantic instead accepts, for example, `"1_000"` for an int, `"yes"`/`"off"` for a bool, braced
or URN UUIDs, and unix timestamps for datetimes. Using Ajv would have silently changed which
requests the API accepts. So:

- `src/utils/pydantic.js` re-implements the Pydantic v2 lax rules for the field types used:
  int, bool, str, UUID (the Rust `uuid` crate diagnostics), HttpUrl (WHATWG plus `url` crate
  error reasons), datetime (speedate), enum, list and model. It is verified case by case against
  **2741** results recorded from the reference's pydantic 2.13.5
  (`test/fixtures/pydantic-lax.json`, `test/unit/pydantic-parity.test.js`).
- `src/utils/request-validation.js` compiles the existing route JSON schemas (still used for
  Swagger and response serialisation) into those validators. It reports path → query → body
  errors together, in declaration order, like FastAPI. A missing body and a JSON `null` body
  behave as in FastAPI: `missing`, `None`, or the model's `default_factory`.
- `src/utils/pyjson.js` ports `json.detect_encoding` and CPython's `_json` scanner:
  - It accepts what Python accepts: `NaN`, `Infinity`, and UTF-8-sig/UTF-16/UTF-32 bodies.
  - Invalid JSON returns the same `json_invalid` message and code-point position. This is
    verified against 84 CPython results (`test/fixtures/python-json.json`).
  - Undecodable bytes return 400 "There was an error parsing the body".
- Content types follow FastAPI 0.141 (`strict_content_type=True`). Only `application/json` and
  `application/*+json` are parsed; other or missing content types leave the raw body, which
  fails model validation with the raw text as `input`.

## 3. Differences (intentional or unavoidable)

| # | Difference | Impact |
|---|---|---|
| 1 | The OpenAPI document is generated by `@fastify/swagger`, not FastAPI. It has the same 14 operations, paths, methods, response codes and schema names. Wording, `operationId`s and ordering differ, and Python's separate `ErrorBody` component is inlined into `ErrorResponse`. `/docs/json` is added; `/openapi.json`, `/docs` and `/redoc` exist in both. Swagger UI assets are served locally; `/docs/oauth2-redirect` is not served (no OAuth is configured). | Docs only. |
| 2 | JSON numbers: a Python float with an integral value serialises as `2.0`, Node as `2` (e.g. `crawl_delay`, `retrieval_score`, `duration_seconds`). | Same value for any JSON parser. |
| 3 | A float literal with an integral value in a request (`5.0`) cannot be told apart from `5` after JSON parsing. It is treated as an int, which only matters above 2^63, where Pydantic reports `int_parsing_size` and Node reports the range error. Integers above 2^53 lose precision. | No realistic input is affected; every int field is range-limited. |
| 4 | The HTTP reason phrase for 422 is `Unprocessable Entity` (Node) versus `Unprocessable Content` (h11). | Status code identical. |
| 5 | Request bodies are limited to 100 MiB (Fastify requires a limit; uvicorn has none). The limit returns 413 `HTTP_ERROR`. | Far above realistic bulk upserts. |
| 6 | UTF-8 bodies containing encoded lone surrogates (Python `surrogatepass`) return 400 in Node. | Pathological input only. |
| 7 | On *malformed* HTML, htmlparser2 and BeautifulSoup (`html.parser`) can close implied tags differently, which can change extracted text for broken markup. Well-formed pages produce identical output (checked on samples and the production NEXT_REDIRECT fixture). | Crawler extraction on broken HTML. |
| 8 | Logs are pino JSON, not Python `logging` text. API keys, AI keys and DB passwords are never logged. | Operations only. |
| 9 | The re-approve conflict (a second active suggestion for the same pair) is raised by `saveSuggestion` (an explicit UPDATE) instead of at the ORM flush inside `commit()`. The API result is the same: 409 `ACTIVE_SUGGESTION_EXISTS`. | Internal only. |

## 4. Verification

The commands were run on 2026-09-22, and every result below is from an actual run.

| Check | Result |
|---|---|
| `npm test` (unit + API, AI and network mocked) | 21 files, **3131 passed** |
| `npm run test:integration` (PostgreSQL `link_automation_test`, migrated up/down) | 2 files, **16 passed** |
| `npm run lint` | clean |
| Python reference `pytest` | **277 passed** (unchanged) |
| Python sources fingerprint (80 files, SHA-256) | unchanged |
| HTTP parity: the Node and Python servers run side by side on the dev DB and receive the same 136 requests (read-only or rejected before any write). Status, content-type, location, allow and body are compared byte for byte. | **135 identical**; 1 difference: the OpenAPI document (item 1) |

Every Python test module has a Vitest counterpart with the same cases:

- `tests/unit/test_*.py` → `test/unit/*.test.js`
- `tests/api/*` → `test/api/*`
- `tests/integration/*` → `test/integration/*`

Extra Node-only tests:

- The Pydantic and JSON parity suites.
- `test/api/fastapi-parity.test.js`, which covers routing, validation and body parsing, with
  expected bodies recorded from the Python server.
- A few extra edge cases (a nested sitemap index, an applier window check).

The security tests (SSRF static and connect-time, redirect-to-internal, robots) are all ported;
none is skipped.

## 5. Not done / pending approval

- **No production crawl has been run from Node.** The 25-page and 200-page smoke crawls of the
  live site need explicit approval. Suggested first run:
  `POST /api/sites/{site_id}/crawl` with `{"max_pages": 25}`, then compare the stored rows with
  the Python crawl.
- The Python code stays in place until Node has been validated in production.
- The repository has no commits yet. Commit the Python baseline (without `.env`) before relying
  on git history.
