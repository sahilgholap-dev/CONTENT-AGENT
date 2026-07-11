"""SQLite storage for CasinoGurus content-engine batch outputs.

The crew's final task (`assemble_draft_package_for_review_queue`) emits a batch
JSON object: a envelope of counts plus a list of Draft Packages. This module
persists that batch into a SQLite database so runs accumulate over time and can
be queried (by pillar, status, date, cited source, verification flag, etc.).

Design: hybrid. Every queryable field gets its own column, but the full nested
objects (draft / compliance_scorecard / seo_quality_scorecard) are ALSO stored
verbatim as JSON so the database is a lossless record of every run. Two child
tables (source_notes, verification_flags) are normalized out so you can query
citations and flags across all articles.

Usage
-----
    # ingest a saved batch file
    python -m casinogurus_ai_content_engine___daily_5_topic_batch.storage ingest Sample_Output.json

    # from code, right after crew.kickoff():
    from casinogurus_ai_content_engine___daily_5_topic_batch.storage import save_batch
    result = crew.kickoff(inputs=inputs)
    save_batch(result.json_dict or json.loads(result.raw), source="crew_run")
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from typing import Any

# Default DB lives at the project root (four levels up from this file:
# storage.py -> package -> src -> project root).
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_DB_PATH = os.environ.get(
    "CONTENT_ENGINE_DB", os.path.join(_PROJECT_ROOT, "content_engine.db")
)


SCHEMA = """
CREATE TABLE IF NOT EXISTS batches (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_date             TEXT,
    total_packages         INTEGER,
    ready_for_review_count INTEGER,
    needs_review_count     INTEGER,
    source                 TEXT,             -- file path or "crew_run"
    ingested_at            TEXT NOT NULL,    -- UTC ISO timestamp of ingestion
    raw_json               TEXT NOT NULL     -- full batch object, verbatim
);

CREATE TABLE IF NOT EXISTS packages (
    package_id                 TEXT PRIMARY KEY,
    batch_id                   INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    topic                      TEXT,
    primary_keyword            TEXT,
    pillar                     TEXT,
    created_at                 TEXT,
    revision_count             INTEGER,
    review_status              TEXT,
    escalation_reason          TEXT,
    reviewer_notes             TEXT,
    -- flattened draft fields (queryable); full draft kept in draft_json
    seo_title                  TEXT,
    meta_description           TEXT,
    slug                       TEXT,
    category                   TEXT,
    excerpt                    TEXT,
    featured_image_prompt      TEXT,
    responsible_gambling_note  TEXT,
    body_html                  TEXT,
    -- scorecard summaries (queryable); full scorecards kept as JSON
    compliance_verdict         TEXT,
    seo_verdict                TEXT,
    seo_overall_score          REAL,
    -- lossless nested objects
    draft_json                 TEXT,
    compliance_json            TEXT,
    seo_json                   TEXT
);

CREATE TABLE IF NOT EXISTS source_notes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id       TEXT NOT NULL REFERENCES packages(package_id) ON DELETE CASCADE,
    claim            TEXT,
    fact_store_entry TEXT,
    source_url       TEXT,
    confidence       TEXT
);

CREATE TABLE IF NOT EXISTS verification_flags (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id        TEXT NOT NULL REFERENCES packages(package_id) ON DELETE CASCADE,
    flag              TEXT,
    location_in_draft TEXT
);

CREATE TABLE IF NOT EXISTS images (
    package_id  TEXT PRIMARY KEY REFERENCES packages(package_id) ON DELETE CASCADE,
    prompt      TEXT,          -- the generation prompt actually sent (alt stripped)
    alt_text    TEXT,          -- alt='...' parsed out of featured_image_prompt
    image_b64   TEXT,          -- base64-encoded image bytes (no data: prefix)
    mime_type   TEXT,          -- e.g. image/png
    model       TEXT,          -- generation model used
    size        TEXT,          -- e.g. 1024x1024
    status      TEXT,          -- 'ok' | 'error'
    error       TEXT,          -- error message when status = 'error'
    created_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_packages_batch    ON packages(batch_id);
CREATE INDEX IF NOT EXISTS idx_packages_pillar   ON packages(pillar);
CREATE INDEX IF NOT EXISTS idx_packages_status   ON packages(review_status);
CREATE INDEX IF NOT EXISTS idx_batches_date      ON batches(batch_date);
CREATE INDEX IF NOT EXISTS idx_srcnotes_package  ON source_notes(package_id);
CREATE INDEX IF NOT EXISTS idx_flags_package     ON verification_flags(package_id);
"""

# Columns of the images table, in order, used for preserve/restore on re-ingest.
_IMAGE_COLS = (
    "package_id", "prompt", "alt_text", "image_b64",
    "mime_type", "model", "size", "status", "error", "created_at",
)


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def connect(db_path: str = DEFAULT_DB_PATH) -> sqlite3.Connection:
    """Open a connection with foreign keys + WAL enabled and the schema ensured."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.executescript(SCHEMA)
    return conn


def init_db(db_path: str = DEFAULT_DB_PATH) -> str:
    """Create the database file and schema if they do not exist. Returns the path."""
    conn = connect(db_path)
    conn.commit()
    conn.close()
    return db_path


def _coerce_batch(batch: Any) -> dict:
    """Accept a dict, a JSON string, or a CrewOutput-like object; return a dict batch."""
    if isinstance(batch, str):
        return json.loads(batch)
    if isinstance(batch, dict):
        return batch
    # CrewOutput duck-typing
    for attr in ("json_dict", "to_dict"):
        val = getattr(batch, attr, None)
        val = val() if callable(val) else val
        if isinstance(val, dict) and val:
            return val
    raw = getattr(batch, "raw", None)
    if isinstance(raw, str):
        raw = raw.strip()
        if raw.startswith("```json"):
            raw = raw[7:]
        elif raw.startswith("```"):
            raw = raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        return json.loads(raw.strip())
    raise TypeError(f"Cannot interpret batch of type {type(batch)!r} as a batch dict.")


def save_batch(
    batch: Any, source: str = "unknown", db_path: str = DEFAULT_DB_PATH
) -> int:
    """Persist one batch (and all its packages) into the database.

    Idempotent per source: re-ingesting the same `source` replaces the prior
    batch row and its packages (via ON DELETE CASCADE). Returns the batch row id.
    """
    data = _coerce_batch(batch)
    packages = data.get("packages", []) or []

    conn = connect(db_path)
    try:
        with conn:  # single transaction
            # Snapshot any already-generated images for this source so re-ingesting
            # the same file does not wipe them (the batch delete cascades to images).
            preserved = conn.execute(
                """SELECT * FROM images WHERE package_id IN (
                       SELECT package_id FROM packages WHERE batch_id IN (
                           SELECT id FROM batches WHERE source = ?))""",
                (source,),
            ).fetchall()
            preserved = [dict(r) for r in preserved]

            # Replace any prior ingest from the same source to stay idempotent.
            old = conn.execute(
                "SELECT id FROM batches WHERE source = ?", (source,)
            ).fetchall()
            for row in old:
                conn.execute("DELETE FROM batches WHERE id = ?", (row["id"],))

            cur = conn.execute(
                """INSERT INTO batches
                   (batch_date, total_packages, ready_for_review_count,
                    needs_review_count, source, ingested_at, raw_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    data.get("batch_date"),
                    data.get("total_packages", len(packages)),
                    data.get("ready_for_review_count"),
                    data.get("needs_review_count"),
                    source,
                    _utcnow_iso(),
                    json.dumps(data, ensure_ascii=False),
                ),
            )
            batch_id = cur.lastrowid

            for pkg in packages:
                _insert_package(conn, batch_id, pkg)

            # Restore preserved images for any package_id that still exists.
            existing = {
                r["package_id"]
                for r in conn.execute("SELECT package_id FROM packages").fetchall()
            }
            for img in preserved:
                if img["package_id"] in existing:
                    conn.execute(
                        f"INSERT OR REPLACE INTO images ({','.join(_IMAGE_COLS)}) "
                        f"VALUES ({','.join('?' * len(_IMAGE_COLS))})",
                        tuple(img[c] for c in _IMAGE_COLS),
                    )

        return batch_id
    finally:
        conn.close()


def _insert_package(conn: sqlite3.Connection, batch_id: int, pkg: dict) -> None:
    draft = pkg.get("draft", {}) or {}
    compliance = pkg.get("compliance_scorecard", {}) or {}
    seo = pkg.get("seo_quality_scorecard", {}) or {}
    package_id = pkg.get("package_id")

    conn.execute(
        """INSERT OR REPLACE INTO packages (
               package_id, batch_id, topic, primary_keyword, pillar, created_at,
               revision_count, review_status, escalation_reason, reviewer_notes,
               seo_title, meta_description, slug, category, excerpt,
               featured_image_prompt, responsible_gambling_note, body_html,
               compliance_verdict, seo_verdict, seo_overall_score,
               draft_json, compliance_json, seo_json
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            package_id,
            batch_id,
            pkg.get("topic"),
            pkg.get("primary_keyword"),
            pkg.get("pillar"),
            pkg.get("created_at"),
            pkg.get("revision_count"),
            pkg.get("review_status"),
            pkg.get("escalation_reason"),
            pkg.get("reviewer_notes"),
            draft.get("seo_title"),
            draft.get("meta_description"),
            draft.get("slug"),
            draft.get("category"),
            draft.get("excerpt"),
            draft.get("featured_image_prompt"),
            draft.get("responsible_gambling_note"),
            draft.get("body_html"),
            compliance.get("overall_verdict"),
            seo.get("overall_verdict"),
            seo.get("overall_score"),
            json.dumps(draft, ensure_ascii=False),
            json.dumps(compliance, ensure_ascii=False),
            json.dumps(seo, ensure_ascii=False),
        ),
    )

    # Refresh children (INSERT OR REPLACE on the package keeps rows around).
    conn.execute("DELETE FROM source_notes WHERE package_id = ?", (package_id,))
    conn.execute("DELETE FROM verification_flags WHERE package_id = ?", (package_id,))

    for note in draft.get("source_notes", []) or []:
        conn.execute(
            """INSERT INTO source_notes
               (package_id, claim, fact_store_entry, source_url, confidence)
               VALUES (?, ?, ?, ?, ?)""",
            (
                package_id,
                note.get("claim"),
                note.get("fact_store_entry"),
                note.get("source_url"),
                note.get("confidence"),
            ),
        )

    # verification_flags may live on the draft (objects) or the package (strings).
    for flag in draft.get("verification_flags", []) or []:
        if isinstance(flag, dict):
            conn.execute(
                "INSERT INTO verification_flags (package_id, flag, location_in_draft) VALUES (?, ?, ?)",
                (package_id, flag.get("flag"), flag.get("location_in_draft")),
            )
        else:
            conn.execute(
                "INSERT INTO verification_flags (package_id, flag, location_in_draft) VALUES (?, ?, ?)",
                (package_id, str(flag), None),
            )


def save_image(
    package_id: str,
    image_b64: str | None = None,
    *,
    prompt: str | None = None,
    alt_text: str | None = None,
    mime_type: str = "image/png",
    model: str | None = None,
    size: str | None = None,
    status: str = "ok",
    error: str | None = None,
    db_path: str = DEFAULT_DB_PATH,
    conn: sqlite3.Connection | None = None,
) -> None:
    """Insert or replace the featured image for a package (one image per package)."""
    own = conn is None
    conn = conn or connect(db_path)
    try:
        conn.execute(
            f"INSERT OR REPLACE INTO images ({','.join(_IMAGE_COLS)}) "
            f"VALUES ({','.join('?' * len(_IMAGE_COLS))})",
            (
                package_id, prompt, alt_text, image_b64,
                mime_type, model, size, status, error, _utcnow_iso(),
            ),
        )
        if own:
            conn.commit()
    finally:
        if own:
            conn.close()


def get_image(package_id: str, db_path: str = DEFAULT_DB_PATH) -> dict | None:
    """Return the stored image row for a package as a dict, or None."""
    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT * FROM images WHERE package_id = ?", (package_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def save_batch_from_file(path: str, db_path: str = DEFAULT_DB_PATH) -> int:
    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return save_batch(data, source=os.path.abspath(path), db_path=db_path)


def summary(db_path: str = DEFAULT_DB_PATH) -> None:
    """Print a short overview of what's stored."""
    conn = connect(db_path)
    try:
        b = conn.execute("SELECT COUNT(*) n FROM batches").fetchone()["n"]
        p = conn.execute("SELECT COUNT(*) n FROM packages").fetchone()["n"]
        print(f"DB: {db_path}")
        print(f"  batches:  {b}")
        print(f"  packages: {p}")
        rows = conn.execute(
            """SELECT pillar, review_status, COUNT(*) n
               FROM packages GROUP BY pillar, review_status ORDER BY pillar"""
        ).fetchall()
        for r in rows:
            print(f"    {r['pillar'] or '?':<10} {r['review_status'] or '?':<22} {r['n']}")
    finally:
        conn.close()


def _main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(
            "Usage:\n"
            "  python -m ...storage init [db_path]\n"
            "  python -m ...storage ingest <batch.json> [db_path]\n"
            "  python -m ...storage summary [db_path]"
        )
        return 0

    cmd = argv[0]
    if cmd == "init":
        db = argv[1] if len(argv) > 1 else DEFAULT_DB_PATH
        print("Initialized", init_db(db))
        return 0
    if cmd == "ingest":
        if len(argv) < 2:
            print("ingest requires a path to a batch JSON file", file=sys.stderr)
            return 2
        db = argv[2] if len(argv) > 2 else DEFAULT_DB_PATH
        bid = save_batch_from_file(argv[1], db_path=db)
        print(f"Ingested '{argv[1]}' as batch id {bid} into {db}")
        summary(db)
        return 0
    if cmd == "summary":
        db = argv[1] if len(argv) > 1 else DEFAULT_DB_PATH
        summary(db)
        return 0

    print(f"Unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
