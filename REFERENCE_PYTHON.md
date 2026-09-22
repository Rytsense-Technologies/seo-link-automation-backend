# Python reference implementation

The Python/FastAPI backend (`app/`, `tests/`, `alembic/`, `pyproject.toml`, `requirements*.txt`)
is the **behavioural source of truth** for the Node.js port in `src/`.

- It is kept unchanged on the `node-js-migration` branch and remains runnable
  (`uvicorn app.main:app`, `pytest`, `alembic`).
- Where Node and Python disagree, Python is correct unless the difference is listed as
  intentional in `NODE_MIGRATION_NOTES.md`.
- Do not delete it until the Node implementation has been validated in production.

Note: this repository has **no commits yet**, so the branch alone does not snapshot the Python
code. Commit the Python baseline (without `.env`) before relying on git history as a backup.
