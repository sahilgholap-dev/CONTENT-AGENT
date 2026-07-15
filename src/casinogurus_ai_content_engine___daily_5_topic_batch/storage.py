"""PostgreSQL storage for CasinoGurus content-engine batch outputs (Supabase).

The crew's final task (`assemble_draft_package_for_review_queue`) emits a batch
JSON object: an envelope of counts plus a list of Draft Packages. This module
persists that batch into Postgres so runs accumulate over time and can be
queried (by pillar, status, date, cited source, verification flag, etc.).

Design (unchanged from the original SQLite version): hybrid. Every queryable
field gets its own column, but the full nested objects (draft /
compliance_scorecard / seo_quality_scorecard / whole batch) are ALSO stored
verbatim as JSONB so the database is a lossless record of every run. Two child
tables (source_notes, verification_flags) are normalized out so you can query
citations and flags across all articles.

Connections come from the shared pool in ``db.py``; there is no local DB file.

Usage
-----
    # create the schema in the configured DATABASE_URL
    python -m casinogurus_ai_content_engine___daily_5_topic_batch.storage init

    # ingest a saved batch file
    python -m casinogurus_ai_content_engine___daily_5_topic_batch.storage ingest Sample_Output.json

    # from code, right after crew.kickoff():
    from casinogurus_ai_content_engine___daily_5_topic_batch.storage import save_batch
    result = crew.kickoff(inputs=inputs)
    save_batch(result.json_dict or json.loads(result.raw), source="crew_run")
"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from typing import Any

from psycopg.types.json import Jsonb

from casinogurus_ai_content_engine___daily_5_topic_batch.db import (
    _PROJECT_ROOT,  # re-exported for callers that still import it
    connection,
    init_schema,
)

__all__ = [
    "_PROJECT_ROOT",
    "init_schema",
    "save_batch",
    "save_batch_from_file",
    "save_image",
    "get_image",
    "summary",
]

# Columns of the packages table, in insert order. Used to build the upsert.
_PKG_COLS = (
    "package_id", "batch_id", "topic", "primary_keyword", "pillar", "created_at",
    "revision_count", "review_status", "escalation_reason", "reviewer_notes",
    "seo_title", "meta_description", "slug", "category", "excerpt",
    "featured_image_prompt", "responsible_gambling_note", "body_html",
    "compliance_verdict", "seo_verdict", "seo_overall_score",
    "draft_json", "compliance_json", "seo_json",
)

# Columns of the images table, in order, used for upsert and preserve/restore.
_IMAGE_COLS = (
    "package_id", "prompt", "alt_text", "image_b64",
    "mime_type", "model", "size", "status", "error", "created_at",
)


def _upsert_sql(table: str, cols: tuple[str, ...], conflict: str) -> str:
    """Build an INSERT ... ON CONFLICT (<conflict>) DO UPDATE upsert (the
    Postgres equivalent of SQLite's INSERT OR REPLACE, but without deleting the
    row, so child/image rows referencing it survive)."""
    placeholders = ",".join(["%s"] * len(cols))
    updates = ",".join(f"{c}=EXCLUDED.{c}" for c in cols if c != conflict)
    return (
        f"INSERT INTO {table} ({','.join(cols)}) VALUES ({placeholders}) "
        f"ON CONFLICT ({conflict}) DO UPDATE SET {updates}"
    )


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _extract_json_span(text: str) -> str | None:
    """Return the substring from the first opening bracket to its matching close.

    Handles LLM output that wraps the JSON in prose ("Here is the batch: {...}")
    by scanning for balanced brackets (ignoring braces inside string literals).
    Returns None if no balanced object/array is found.
    """
    start = None
    for i, ch in enumerate(text):
        if ch in "{[":
            start = i
            break
    if start is None:
        return None

    open_ch = text[start]
    close_ch = "}" if open_ch == "{" else "]"
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start : i + 1]
    return None  # unbalanced (e.g. truncated output)


def _loads_lenient(text: str) -> Any:
    """Parse JSON that may be wrapped in markdown fences or surrounding prose."""
    text = text.strip()
    # 1) Straight parse.
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 2) Content inside a ```json ... ``` (or bare ``` ... ```) fence, anywhere.
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    if fence:
        inner = fence.group(1).strip()
        try:
            return json.loads(inner)
        except json.JSONDecodeError:
            text = inner  # fall through to bracket extraction on the fenced body
    # 3) Balanced {...} / [...] span, ignoring any leading/trailing prose.
    # NOTE: we deliberately do NOT "repair" malformed JSON here. The crew's final
    # task uses output_pydantic (see crew.py / models.Batch), so CrewAI produces
    # valid JSON via tool-calling. If parsing still fails, we raise loudly rather
    # than silently saving corrupted content; the raw output is kept in runs/.
    span = _extract_json_span(text)
    target = span if span is not None else text
    return json.loads(target)


def _coerce_batch(batch: Any) -> dict:
    """Accept a dict, a JSON string, or a CrewOutput-like object; return a dict batch."""
    if isinstance(batch, str):
        return _loads_lenient(batch)
    if isinstance(batch, dict):
        return batch
    # CrewOutput with output_pydantic set: use the validated model directly.
    pyd = getattr(batch, "pydantic", None)
    if pyd is not None and hasattr(pyd, "model_dump"):
        try:
            val = pyd.model_dump()
            if isinstance(val, dict) and "packages" in val:
                return val
        except Exception:
            pass
    # CrewOutput duck-typing: prefer a structured dict when CrewAI parsed one.
    # to_dict() can itself raise (it json.loads() the raw output internally), so
    # guard each access and fall through to lenient raw parsing on failure.
    for attr in ("json_dict", "to_dict"):
        try:
            val = getattr(batch, attr, None)
            val = val() if callable(val) else val
        except Exception:
            continue
        if isinstance(val, dict) and val and "packages" in val:
            return val
    raw = getattr(batch, "raw", None)
    if isinstance(raw, str) and raw.strip():
        return _loads_lenient(raw)
    raise TypeError(f"Cannot interpret batch of type {type(batch)!r} as a batch dict.")


def save_batch(batch: Any, source: str = "unknown") -> int:
    """Persist one batch (and all its packages) into the database.

    Idempotent per source: re-ingesting the same `source` replaces the prior
    batch row and its packages (via ON DELETE CASCADE). Returns the batch row id.
    The whole operation runs in one transaction (one pooled connection).
    """
    data = _coerce_batch(batch)
    packages = data.get("packages", []) or []

    with connection() as conn:
        # Snapshot any already-generated images for this source so re-ingesting
        # the same file does not wipe them (the batch delete cascades to images).
        preserved = conn.execute(
            """SELECT * FROM images WHERE package_id IN (
                   SELECT package_id FROM packages WHERE batch_id IN (
                       SELECT id FROM batches WHERE source = %s))""",
            (source,),
        ).fetchall()
        preserved = [dict(r) for r in preserved]

        # Replace any prior ingest from the same source to stay idempotent.
        conn.execute("DELETE FROM batches WHERE source = %s", (source,))

        batch_id = conn.execute(
            """INSERT INTO batches
               (batch_date, total_packages, ready_for_review_count,
                needs_review_count, source, ingested_at, raw_json)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (
                data.get("batch_date"),
                data.get("total_packages", len(packages)),
                data.get("ready_for_review_count"),
                data.get("needs_review_count"),
                source,
                _utcnow(),
                Jsonb(data),
            ),
        ).fetchone()["id"]

        for pkg in packages:
            _insert_package(conn, batch_id, pkg)

        # Restore preserved images for any package_id that still exists.
        existing = {
            r["package_id"]
            for r in conn.execute("SELECT package_id FROM packages").fetchall()
        }
        upsert = _upsert_sql("images", _IMAGE_COLS, "package_id")
        for img in preserved:
            if img["package_id"] in existing:
                conn.execute(upsert, tuple(img[c] for c in _IMAGE_COLS))

    return batch_id


def _insert_package(conn, batch_id: int, pkg: dict) -> None:
    draft = pkg.get("draft", {}) or {}
    compliance = pkg.get("compliance_scorecard", {}) or {}
    seo = pkg.get("seo_quality_scorecard", {}) or {}
    package_id = pkg.get("package_id")

    conn.execute(
        _upsert_sql("packages", _PKG_COLS, "package_id"),
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
            Jsonb(draft),
            Jsonb(compliance),
            Jsonb(seo),
        ),
    )

    # Refresh children (the upsert above keeps the package row, so its child
    # rows survive; we clear and re-insert them from the latest payload).
    conn.execute("DELETE FROM source_notes WHERE package_id = %s", (package_id,))
    conn.execute("DELETE FROM verification_flags WHERE package_id = %s", (package_id,))

    for note in draft.get("source_notes", []) or []:
        conn.execute(
            """INSERT INTO source_notes
               (package_id, claim, fact_store_entry, source_url, confidence)
               VALUES (%s, %s, %s, %s, %s)""",
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
                "INSERT INTO verification_flags (package_id, flag, location_in_draft) VALUES (%s, %s, %s)",
                (package_id, flag.get("flag"), flag.get("location_in_draft")),
            )
        else:
            conn.execute(
                "INSERT INTO verification_flags (package_id, flag, location_in_draft) VALUES (%s, %s, %s)",
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
    conn=None,
) -> None:
    """Insert or replace the featured image for a package (one image per package).

    When ``conn`` is provided the write runs inside that caller's transaction;
    otherwise it borrows and commits its own pooled connection.
    """
    values = (
        package_id, prompt, alt_text, image_b64,
        mime_type, model, size, status, error, _utcnow(),
    )
    sql = _upsert_sql("images", _IMAGE_COLS, "package_id")
    if conn is not None:
        conn.execute(sql, values)
        return
    with connection() as own:
        own.execute(sql, values)


def get_image(package_id: str) -> dict | None:
    """Return the stored image row for a package as a dict, or None."""
    with connection() as conn:
        row = conn.execute(
            "SELECT * FROM images WHERE package_id = %s", (package_id,)
        ).fetchone()
        return dict(row) if row else None


def save_batch_from_file(path: str) -> int:
    import os

    with open(path, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    return save_batch(data, source=os.path.abspath(path))


def summary() -> None:
    """Print a short overview of what's stored."""
    with connection() as conn:
        b = conn.execute("SELECT COUNT(*) AS n FROM batches").fetchone()["n"]
        p = conn.execute("SELECT COUNT(*) AS n FROM packages").fetchone()["n"]
        print(f"  batches:  {b}")
        print(f"  packages: {p}")
        rows = conn.execute(
            """SELECT pillar, review_status, COUNT(*) AS n
               FROM packages GROUP BY pillar, review_status ORDER BY pillar"""
        ).fetchall()
        for r in rows:
            print(f"    {r['pillar'] or '?':<10} {r['review_status'] or '?':<22} {r['n']}")


def _main(argv: list[str]) -> int:
    if not argv or argv[0] in ("-h", "--help"):
        print(
            "Usage:\n"
            "  python -m ...storage init            # create schema in DATABASE_URL\n"
            "  python -m ...storage ingest <batch.json>\n"
            "  python -m ...storage summary"
        )
        return 0

    cmd = argv[0]
    if cmd == "init":
        init_schema()
        print("Schema applied to DATABASE_URL.")
        return 0
    if cmd == "ingest":
        if len(argv) < 2:
            print("ingest requires a path to a batch JSON file", file=sys.stderr)
            return 2
        init_schema()
        bid = save_batch_from_file(argv[1])
        print(f"Ingested '{argv[1]}' as batch id {bid}.")
        summary()
        return 0
    if cmd == "summary":
        summary()
        return 0

    print(f"Unknown command: {cmd}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
