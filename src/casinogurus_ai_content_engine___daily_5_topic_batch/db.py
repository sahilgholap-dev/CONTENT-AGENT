"""PostgreSQL connection layer for the CasinoGurus content store (Supabase).

Replaces the old per-call ``sqlite3.connect``. A single lazily-created
``psycopg_pool.ConnectionPool`` is shared across the process; callers borrow a
connection with the ``connection()`` context manager, which commits on clean
exit, rolls back on exception, and returns the connection to the pool either way.

Configuration (env vars, also loaded from the project ``.env`` for local runs):
    DATABASE_URL   required. The Supabase Postgres connection string, e.g.
                   postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres
                   (or the :6543 transaction pooler URL).
    DB_POOL_MAX    optional, default 5. Max pooled connections.

Rows are returned as dicts (``psycopg.rows.dict_row``) so existing access
patterns like ``row["id"]`` and ``dict(row)`` keep working unchanged.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Iterator

# Project root (two levels up: db.py -> package -> src -> project root).
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
_SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "schema.sql")

_pool = None  # type: ignore[var-annotated]


def load_dotenv() -> None:
    """Load KEY=VALUE pairs from the project .env into os.environ.

    Non-empty values overwrite so an edited .env takes effect on the next run;
    blank entries never clobber a real shell-exported value. Mirrors the loader
    previously living in images.py so both the API and the CLI behave the same.
    """
    path = os.path.join(_PROJECT_ROOT, ".env")
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip("'\"")
            if val:
                os.environ[key] = val
            else:
                os.environ.setdefault(key, val)


def _database_url() -> str:
    load_dotenv()
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set. Add the Supabase Postgres connection string "
            "to the project .env or the environment (see .env.example)."
        )
    return url


def get_pool():
    """Return the process-wide connection pool, creating it on first use."""
    global _pool
    if _pool is None:
        from psycopg_pool import ConnectionPool
        from psycopg.rows import dict_row

        _pool = ConnectionPool(
            conninfo=_database_url(),
            min_size=1,
            max_size=int(os.environ.get("DB_POOL_MAX", "5")),
            # dict rows keep row["col"]/dict(row) working; prepare_threshold=None
            # keeps us compatible with the Supabase transaction pooler (PgBouncer).
            kwargs={"row_factory": dict_row, "prepare_threshold": None},
            open=True,
        )
    return _pool


@contextmanager
def connection() -> Iterator["object"]:
    """Borrow a pooled connection.

    Commits on clean exit, rolls back on exception, and always returns the
    connection to the pool. Use one ``with connection() as conn:`` block per
    logical unit of work (a whole ``save_batch`` runs in a single block, so it
    is one transaction, matching the original SQLite behaviour).
    """
    pool = get_pool()
    with pool.connection() as conn:
        yield conn


def _split_statements(schema: str) -> list[str]:
    """Split a SQL script into individual statements.

    psycopg3 uses the extended protocol, which rejects multiple commands in one
    ``execute``, so the schema is applied one statement at a time. Line comments
    (``-- ...``) are stripped first because they may themselves contain ``;``
    (e.g. "-- queryable; full draft kept in draft_json"), which would otherwise
    corrupt a naive split. Our schema has no ``--`` inside string literals, so
    cutting each line at ``--`` is safe.
    """
    no_comments = "\n".join(line.split("--", 1)[0] for line in schema.splitlines())
    return [stmt.strip() for stmt in no_comments.split(";") if stmt.strip()]


def init_schema() -> None:
    """Apply schema.sql idempotently. Safe to call on every startup."""
    with open(_SCHEMA_PATH, "r", encoding="utf-8") as fh:
        schema = fh.read()
    with connection() as conn:
        for stmt in _split_statements(schema):
            conn.execute(stmt)


def close_pool() -> None:
    """Close the pool (used on app shutdown)."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None
