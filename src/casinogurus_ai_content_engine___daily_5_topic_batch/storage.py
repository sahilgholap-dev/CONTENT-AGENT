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
import uuid
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
    "list_clients",
    "get_client",
    "upsert_client",
    "insert_profile_version",
    "create_run",
    "get_run",
    "update_run",
    "list_runs",
    "add_package_review",
    "latest_reviews_for_packages",
    "seed_registry_defaults",
    "list_content_types",
    "upsert_content_type",
    "delete_content_type",
    "list_formats",
    "get_format_row",
    "resolve_format_spec",
    "upsert_format",
    "delete_format",
    "serialisable_registry",
]

# Columns of the packages table, in insert order. Used to build the upsert.
_PKG_COLS = (
    "package_id", "batch_id", "topic", "primary_keyword", "pillar", "created_at",
    "revision_count", "review_status", "escalation_reason", "reviewer_notes",
    "seo_title", "meta_description", "slug", "category", "excerpt",
    "featured_image_prompt", "responsible_gambling_note", "body_html",
    "compliance_verdict", "seo_verdict", "seo_overall_score",
    "draft_json", "compliance_json", "seo_json",
    "client_id",
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


# A trustworthy package_id: optional "pkg_" prefix + a real UUID (hex only).
# LLM-emitted ids frequently fail this (invalid hex like 'g', sequential
# patterns like a1b2c3d4..., or labels like "pkg_incomplete-draft-5").
_PKG_ID_RE = re.compile(
    r"^(pkg_)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _ensure_package_ids(conn, packages: list[dict]) -> None:
    """Make every package_id safe to use as the packages-table PRIMARY KEY.

    package_id is emitted by the assemble agent, and LLMs cannot generate
    reliable randomness: fabricated ids can repeat across runs, and the
    packages upsert (ON CONFLICT package_id DO UPDATE) would then silently
    move a package OUT of its earlier batch. Regenerate the id in Python when
    it is missing, malformed, duplicated within this batch, or already taken
    by another batch (the caller deletes same-source rows first, so any
    surviving match belongs to a different batch). Mutates the package dicts
    in place so raw_json and the packages table stay consistent.
    """
    candidates = [
        p.get("package_id")
        for p in packages
        if isinstance(p.get("package_id"), str) and _PKG_ID_RE.match(p["package_id"])
    ]
    taken_elsewhere: set[str] = set()
    if candidates:
        rows = conn.execute(
            "SELECT package_id FROM packages WHERE package_id = ANY(%s)",
            (candidates,),
        ).fetchall()
        taken_elsewhere = {r["package_id"] for r in rows}

    seen: set[str] = set()
    for pkg in packages:
        pid = pkg.get("package_id")
        ok = (
            isinstance(pid, str)
            and _PKG_ID_RE.match(pid)
            and pid not in taken_elsewhere
            and pid not in seen
        )
        if not ok:
            pid = f"pkg_{uuid.uuid4()}"
            pkg["package_id"] = pid
        seen.add(pid)


def save_batch(
    batch: Any,
    source: str = "unknown",
    *,
    client_id: str | None = None,
    content_type: str | None = None,
    format: str | None = None,
    run_id: str | None = None,
    profile_version: int | None = None,
    requested_topic: str | None = None,
) -> int:
    """Persist one batch (and all its packages) into the database.

    Idempotent per source: re-ingesting the same `source` replaces the prior
    batch row and its packages (via ON DELETE CASCADE). Returns the batch row id.
    The whole operation runs in one transaction (one pooled connection).

    Client/run metadata is stamped in Python (never echoed by the LLM): it goes
    into the new batches columns AND as additive top-level keys of raw_json, so
    the Sample_Output.json contract is only ever extended, never changed.
    """
    data = _coerce_batch(batch)
    packages = data.get("packages", []) or []

    run_meta = {
        "client_id": client_id,
        "content_type": content_type,
        "format": format,
        "run_id": run_id,
        "profile_version": profile_version,
        "requested_topic": requested_topic,
    }
    for key, value in run_meta.items():
        if value is not None:
            data[key] = value

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

        # After the same-source delete so a surviving id conflict is always a
        # different batch's. Mutates packages (and therefore data/raw_json).
        _ensure_package_ids(conn, packages)

        batch_id = conn.execute(
            """INSERT INTO batches
               (batch_date, total_packages, ready_for_review_count,
                needs_review_count, source, ingested_at, raw_json,
                client_id, content_type, format, run_id, profile_version)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING id""",
            (
                data.get("batch_date"),
                data.get("total_packages", len(packages)),
                data.get("ready_for_review_count"),
                data.get("needs_review_count"),
                source,
                _utcnow(),
                Jsonb(data),
                client_id,
                content_type,
                format,
                run_id,
                profile_version,
            ),
        ).fetchone()["id"]

        for pkg in packages:
            _insert_package(conn, batch_id, pkg, client_id=client_id)

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


def _insert_package(conn, batch_id: int, pkg: dict, client_id: str | None = None) -> None:
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
            client_id,
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


# ---------------------------------------------------------------------------
# Clients / profiles (append-only versions; active profile = MAX(version))
# ---------------------------------------------------------------------------

def list_clients(include_inactive: bool = True) -> list[dict]:
    """Client rows (no profile text — keep the list light) + latest version."""
    where = "" if include_inactive else "WHERE c.status = 'active'"
    with connection() as conn:
        rows = conn.execute(
            f"""SELECT c.id, c.display_name, c.site_domain, c.status, c.created_at,
                       COALESCE(MAX(p.version), 0) AS profile_version
                FROM clients c
                LEFT JOIN client_profiles p ON p.client_id = c.id
                {where}
                GROUP BY c.id, c.display_name, c.site_domain, c.status, c.created_at
                ORDER BY c.created_at"""
        ).fetchall()
        return [dict(r) for r in rows]


def get_client(client_id: str) -> dict | None:
    """Client row + its active (latest-version) profile document, or None."""
    with connection() as conn:
        row = conn.execute("SELECT * FROM clients WHERE id = %s", (client_id,)).fetchone()
        if not row:
            return None
        client = dict(row)
        prof = conn.execute(
            """SELECT version, profile, created_by, created_at
               FROM client_profiles WHERE client_id = %s
               ORDER BY version DESC LIMIT 1""",
            (client_id,),
        ).fetchone()
        client["profile"] = prof["profile"] if prof else None
        client["profile_version"] = prof["version"] if prof else 0
        return client


def get_client_profile_version(client_id: str, version: int) -> dict | None:
    """A specific pinned profile version (used by runs)."""
    with connection() as conn:
        row = conn.execute(
            "SELECT version, profile FROM client_profiles WHERE client_id = %s AND version = %s",
            (client_id, version),
        ).fetchone()
        return dict(row) if row else None


def upsert_client(client_id: str, display_name: str, site_domain: str, status: str = "active") -> dict:
    with connection() as conn:
        conn.execute(
            """INSERT INTO clients (id, display_name, site_domain, status)
               VALUES (%s, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE
               SET display_name = EXCLUDED.display_name,
                   site_domain = EXCLUDED.site_domain,
                   status = EXCLUDED.status""",
            (client_id, display_name, site_domain, status),
        )
    return get_client(client_id)


def insert_profile_version(client_id: str, profile: dict, created_by: str | None = None) -> int:
    """Append a new immutable profile version; returns the new version number."""
    with connection() as conn:
        version = conn.execute(
            """INSERT INTO client_profiles (client_id, version, profile, created_by)
               VALUES (%s,
                       (SELECT COALESCE(MAX(version), 0) + 1 FROM client_profiles WHERE client_id = %s),
                       %s, %s)
               RETURNING version""",
            (client_id, client_id, Jsonb(profile), created_by),
        ).fetchone()["version"]
    return version


# ---------------------------------------------------------------------------
# Runs (the job record handed to the crew subprocess via --run-id)
# ---------------------------------------------------------------------------

def create_run(client_id: str, content_type: str, format: str, topic: str | None = None) -> dict:
    """Insert a queued run pinned to the client's current profile version."""
    with connection() as conn:
        prof = conn.execute(
            "SELECT COALESCE(MAX(version), 0) AS v FROM client_profiles WHERE client_id = %s",
            (client_id,),
        ).fetchone()
        version = prof["v"]
        if not version:
            raise ValueError(f"client '{client_id}' has no profile version to run against")
        run_id = str(uuid.uuid4())
        row = conn.execute(
            """INSERT INTO runs (id, client_id, profile_version, content_type, format, topic)
               VALUES (%s, %s, %s, %s, %s, %s)
               RETURNING *""",
            (run_id, client_id, version, content_type, format, topic),
        ).fetchone()
        return dict(row)


def get_run(run_id: str) -> dict | None:
    with connection() as conn:
        row = conn.execute("SELECT * FROM runs WHERE id = %s", (run_id,)).fetchone()
        return dict(row) if row else None


def update_run(run_id: str, **fields) -> None:
    """Update whitelisted runs columns (status, error, batch_id, timestamps)."""
    allowed = {"status", "error", "batch_id", "started_at", "finished_at"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        return
    sets = ", ".join(f"{k} = %s" for k in updates)
    with connection() as conn:
        conn.execute(f"UPDATE runs SET {sets} WHERE id = %s", (*updates.values(), run_id))


def list_runs(client_id: str | None = None, limit: int = 50) -> list[dict]:
    with connection() as conn:
        if client_id:
            rows = conn.execute(
                "SELECT * FROM runs WHERE client_id = %s ORDER BY created_at DESC LIMIT %s",
                (client_id, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM runs ORDER BY created_at DESC LIMIT %s", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# Reviewer feedback (append-only event log; learning-loop input)
# ---------------------------------------------------------------------------

def add_package_review(package_id: str, action: str, feedback: str | None, reviewer: str | None) -> dict:
    with connection() as conn:
        pkg = conn.execute(
            "SELECT client_id FROM packages WHERE package_id = %s", (package_id,)
        ).fetchone()
        if not pkg:
            raise KeyError(package_id)
        row = conn.execute(
            """INSERT INTO package_reviews (package_id, client_id, action, feedback, reviewer)
               VALUES (%s, %s, %s, %s, %s)
               RETURNING *""",
            (package_id, pkg["client_id"] or "casinogurus", action, feedback, reviewer),
        ).fetchone()
        # Same shape as latest_reviews_for_packages / pkg["feedback"] merges.
        return {
            "package_id": row["package_id"],
            "status": row["action"],
            "notes": row["feedback"],
            "reviewer": row["reviewer"],
            "created_at": row["created_at"],
        }


def latest_reviews_for_packages(package_ids: list[str]) -> dict[str, dict]:
    """Latest feedback event per package_id (for merging into batch detail)."""
    if not package_ids:
        return {}
    with connection() as conn:
        rows = conn.execute(
            """SELECT DISTINCT ON (package_id)
                      package_id, action AS status, feedback AS notes, reviewer, created_at
               FROM package_reviews
               WHERE package_id = ANY(%s)
               ORDER BY package_id, created_at DESC""",
            (package_ids,),
        ).fetchall()
        return {r["package_id"]: dict(r) for r in rows}


# ---------------------------------------------------------------------------
# Content-type / format catalog ("master"). DB-backed, seeded from registry.py.
# ---------------------------------------------------------------------------

def seed_registry_defaults() -> None:
    """Top-up content_types + formats with any code defaults not yet present.
    ON CONFLICT DO NOTHING per row: user edits and deletions of NON-default
    rows are never touched, and existing default rows keep their edits. (A
    default row the user deleted will reappear after a redeploy — rename or
    disable instead of deleting defaults.)"""
    from casinogurus_ai_content_engine___daily_5_topic_batch import registry

    with connection() as conn:
        for i, (ct_id, label) in enumerate(registry.DEFAULT_CONTENT_TYPES.items()):
            conn.execute(
                """INSERT INTO content_types (id, label, sort_order) VALUES (%s, %s, %s)
                   ON CONFLICT (id) DO NOTHING""",
                (ct_id, label, i),
            )
        for i, spec in enumerate(registry.DEFAULT_FORMATS.values()):
            pipeline = dict(spec.pipeline)
            variant = pipeline.pop("task_variant", "default")
            conn.execute(
                """INSERT INTO formats
                   (id, content_type, label, description, enabled, task_variant,
                    pipeline, stage_labels, sort_order)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (id) DO NOTHING""",
                (
                    spec.id, spec.content_type, spec.label, spec.description, spec.enabled,
                    variant, Jsonb(pipeline), Jsonb(list(spec.stage_labels)), i,
                ),
            )


def list_content_types() -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            "SELECT id, label, sort_order, created_at FROM content_types ORDER BY sort_order, id"
        ).fetchall()
        return [dict(r) for r in rows]


def upsert_content_type(ct_id: str, label: str, sort_order: int = 0) -> dict:
    with connection() as conn:
        conn.execute(
            """INSERT INTO content_types (id, label, sort_order) VALUES (%s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order""",
            (ct_id, label, sort_order),
        )
        row = conn.execute(
            "SELECT id, label, sort_order, created_at FROM content_types WHERE id = %s", (ct_id,)
        ).fetchone()
        return dict(row)


def delete_content_type(ct_id: str) -> None:
    """Deletes the content type and (via cascade) its formats. Historical
    batches keep their format string; the catalog no longer offers it."""
    with connection() as conn:
        conn.execute("DELETE FROM content_types WHERE id = %s", (ct_id,))


def list_formats(content_type: str | None = None, enabled_only: bool = False) -> list[dict]:
    clauses, params = [], {}
    if content_type:
        clauses.append("content_type = %(ct)s")
        params["ct"] = content_type
    if enabled_only:
        clauses.append("enabled = true")
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    with connection() as conn:
        rows = conn.execute(
            f"""SELECT id, content_type, label, description, enabled, task_variant,
                       pipeline, stage_labels, sort_order, created_at
                FROM formats {where} ORDER BY sort_order, id""",
            params,
        ).fetchall()
        return [dict(r) for r in rows]


def get_format_row(format_id: str) -> dict | None:
    with connection() as conn:
        row = conn.execute(
            """SELECT id, content_type, label, description, enabled, task_variant,
                      pipeline, stage_labels, sort_order, created_at
               FROM formats WHERE id = %s""",
            (format_id,),
        ).fetchone()
        return dict(row) if row else None


def resolve_format_spec(format_id: str):
    """Return a FormatSpec for ``format_id`` from the DB, or None if unknown.
    Falls back to the code defaults when the DB is unreachable."""
    from casinogurus_ai_content_engine___daily_5_topic_batch import registry

    try:
        row = get_format_row(format_id)
    except Exception:
        return registry.DEFAULT_FORMATS.get(format_id)
    return registry.spec_from_row(row) if row else None


def upsert_format(
    format_id: str,
    content_type: str,
    label: str,
    description: str = "",
    enabled: bool = True,
    task_variant: str = "default",
    pipeline: dict | None = None,
    stage_labels: list | None = None,
    sort_order: int = 0,
) -> dict:
    with connection() as conn:
        conn.execute(
            """INSERT INTO formats
               (id, content_type, label, description, enabled, task_variant,
                pipeline, stage_labels, sort_order)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET
                   content_type = EXCLUDED.content_type,
                   label = EXCLUDED.label,
                   description = EXCLUDED.description,
                   enabled = EXCLUDED.enabled,
                   task_variant = EXCLUDED.task_variant,
                   pipeline = EXCLUDED.pipeline,
                   stage_labels = EXCLUDED.stage_labels,
                   sort_order = EXCLUDED.sort_order""",
            (
                format_id, content_type, label, description, enabled, task_variant,
                Jsonb(pipeline or {}), Jsonb(stage_labels or []), sort_order,
            ),
        )
    return get_format_row(format_id)


def delete_format(format_id: str) -> None:
    with connection() as conn:
        conn.execute("DELETE FROM formats WHERE id = %s", (format_id,))


def serialisable_registry(enabled_only: bool = True) -> dict:
    """Content types with their (optionally enabled-only) formats nested, for
    cascading selectors. ``pipeline`` params stay backend-internal."""
    cts = list_content_types()
    formats = list_formats(enabled_only=enabled_only)
    by_ct: dict[str, list] = {}
    for f in formats:
        by_ct.setdefault(f["content_type"], []).append(
            {
                "id": f["id"],
                "label": f["label"],
                "description": f["description"],
                "enabled": f["enabled"],
                "stage_labels": list(f.get("stage_labels") or []),
            }
        )
    out = []
    for ct in cts:
        items = by_ct.get(ct["id"], [])
        if enabled_only and not items:
            continue  # hide empty categories from the run modal
        out.append({"id": ct["id"], "label": ct["label"], "formats": items})
    return {"content_types": out}


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
