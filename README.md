# SEO Link Automation – Backend

Python · FastAPI · Pydantic · SQLAlchemy 2 · Alembic · PostgreSQL (administered with pgAdmin).

## Setup

```bash
python -m venv .venv
.venv/Scripts/activate            # Windows (source .venv/bin/activate on Linux/macOS)
pip install -r requirements-dev.txt
cp .env.example .env              # set DATABASE_URL, AI_PROVIDER, AI_API_KEY
```

Create the database (pgAdmin → *Databases → Create*, or `createdb seo_link_automation`), then:

```bash
alembic upgrade head
uvicorn app.main:app --reload     # Swagger UI: http://localhost:8000/docs
```

## Project layout

```
app/
  core/        config (env), error envelope, API-key auth, logging, URL helpers
  db/          SQLAlchemy base/session; db/models.py registers all models for Alembic
  ai/          provider-agnostic LLM interface: Gemini, Groq, OpenAI (httpx, JSON mode)
  content/     position-preserving HTML tokenizer; ContentStore (where page content is saved)
  pages/       page inventory: sites + pages (filled by a crawler/import via PUT /api/sites/{id}/pages)
  interlink/   internal-link automation module (see below)
alembic/       migrations
tests/         unit/ + api/ (no DB, AI mocked) and integration/ (PostgreSQL, opt-in)
```

## Internal interlink module

Pipeline for `POST /api/interlink/analyze`:

1. **Hard filters** (`candidate_filter.py`, deterministic): excludes the source itself, 404/410,
   5xx, redirects, noindex/non-indexable pages, canonicals pointing elsewhere, duplicate URLs,
   other languages, other regions (region-less pages count as global), utility/system pages
   (configurable page types and path regexes), and pages the source already links to.
2. **Duplicate prevention**: skips pairs with a PENDING/APPROVED/APPLIED suggestion
   (also enforced by a partial unique index) and pairs rejected within
   `INTERLINK_REJECTION_COOLDOWN_DAYS`.
3. **Candidate retrieval** (`candidate_retriever.py`): TF-IDF cosine over title, H1, keywords,
   URL slug and meta description, which gives a pool of `INTERLINK_CANDIDATE_POOL_SIZE` (15)
   pages. The `CandidateRetriever` protocol is the pgvector/embeddings extension point.
4. **AI relevance** (`relevance_analyzer.py`): one compact prompt with the source's linkable
   body copy and the candidate pool (IDs, URLs, titles, H1, short excerpts, anchors to avoid).
   The output is validated item by item with Pydantic. Unknown IDs and changed URLs are discarded,
   so the AI cannot invent targets.
5. **Validation** (`anchor_rules.py`, `service.py`): the score must reach
   `INTERLINK_MIN_RELEVANCE_SCORE`. The context must be a verbatim sentence from the linkable
   body copy, and the anchor must be a whole-word substring of it. Generic, stopword-only,
   over-long and keyword-stuffed anchors are rejected, as are anchors reused more than
   `INTERLINK_MAX_ANCHOR_REUSE` times for the same target. Each context and anchor is used once
   per batch, and every suggestion is dry-run through the link applier before it is stored.

**Safe application** (`link_applier.py`): the service re-validates the source and target pages
and the canonical URL, then checks that the source does not already link to the target. It
finds the approved context sentence and wraps the first safe occurrence of the anchor inside
that sentence in one `<a>`. The link is inserted by splicing at exact character offsets, so
the rest of the document stays byte-for-byte identical. It never links inside `<a>`
(so there are no nested links), headings, nav/header/footer, code/pre, script/style, form
controls or SVG, and never across tag boundaries. Content is saved through `ContentStore`
with an optimistic `content_version` check.

The default `DatabaseContentStore` writes `pages.content_html`. No CMS integration exists yet.
To publish to a CMS (for example Sanity/Portable Text), implement `ContentStore` and wire it in
`app/interlink/dependencies.py`.

### Crawler (page inventory)

`app/crawler/` fills the `pages` table from a live website:

1. `robots.txt` is fetched first and follows RFC 9309. It supports `*` and `$` wildcards, the
   longest rule wins, and `Allow` wins ties. A 4xx response means allow all. A 5xx or
   unreachable robots.txt means nothing is crawled. `Crawl-delay` is honoured up to
   `CRAWLER_MAX_CRAWL_DELAY_SECONDS`.
2. **Sitemaps** listed in robots.txt are read, or `/sitemap.xml` when none are declared.
   Sitemap indexes, gzip and plain-text sitemaps are supported. Then the crawl follows
   same-host `<a href>` links breadth-first until `max_pages` pages have been fetched.
3. **URLs are normalised**: fragments, `utm_*` and other tracking parameters, default ports and
   duplicate slashes are removed, and query parameters are sorted. `/a` and `/a/` are the same
   page. Rows are keyed by the stored URL form, so re-crawling updates rows instead of creating
   duplicates.
4. **Storage**: 2xx HTML pages are upserted via `PageService`. The stored main content excludes
   nav, header, footer, aside, scripts, styles, forms and cookie banners. Redirects are stored
   with `redirect_url`. A 4xx/5xx only updates the `http_status` of an existing page and keeps
   its content.
5. **SSRF protection**: http/https only, ports 80/443, no credentials in URLs, and no
   localhost, private, link-local, metadata, CGNAT or multicast addresses. This is enforced when
   the TCP connection is opened, against the resolved IP, so DNS rebinding cannot bypass it.
   Every redirect hop is re-validated.

Crawling only reads the website. Links are still applied only through approve → apply.

### Endpoints

| Method | Path | Description |
|---|---|---|
| POST | `/api/interlink/analyze` | Generate suggestions (`dry_run` supported) |
| GET | `/api/interlink/suggestions` | List (filters: `status`, `site_id`, `source_page_id`, `target_page_id`, `min_relevance_score`, `page`, `page_size`) |
| GET | `/api/interlink/suggestions/{id}` | Detail (includes source/target page summaries) |
| POST | `/api/interlink/suggestions/{id}/approve` | PENDING/REJECTED → APPROVED |
| POST | `/api/interlink/suggestions/{id}/reject` | PENDING/APPROVED → REJECTED (optional `{"reason"}`) |
| POST | `/api/interlink/suggestions/{id}/apply` | APPROVED → APPLIED (inserts the link) |
| POST/GET | `/api/sites` | Register/list websites |
| PUT | `/api/sites/{site_id}/pages` | Bulk upsert crawled/imported pages |
| POST | `/api/sites/{site_id}/crawl` | Crawl the site (robots.txt, sitemaps, same-host links) into `pages` |
| GET | `/api/pages`, `/api/pages/{id}` | Page inventory |

Errors use one envelope: `{"error": {"code": "...", "message": "...", "details": {...}}}`
(404 not found, 409 state conflict, 422 validation/unapplicable, 502 AI failure,
503 database error or AI not configured).

## Quality checks

```bash
ruff format . && ruff check .
mypy
pytest                                   # unit + API tests (no DB, AI mocked)
TEST_DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/seo_link_automation_test pytest -m postgres
alembic upgrade head --sql               # render migration SQL without a DB
```
