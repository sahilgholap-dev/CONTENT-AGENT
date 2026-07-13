#!/usr/bin/env python
"""One-off migration: copy the local SQLite content store into Supabase Postgres.

Reads every batch (stored verbatim as JSON) from the old ``content_engine.db``
and re-saves it through the new Postgres storage layer, then copies any
generated featured images across. Idempotent: ``save_batch`` replaces a prior
ingest with the same ``source``, and images are upserted, so re-running is safe.

Usage
-----
    # DATABASE_URL must point at the target Supabase Postgres (env or .env)
    uv run python scripts/migrate_sqlite_to_pg.py
    uv run python scripts/migrate_sqlite_to_pg.py --sqlite ./content_engine.db

Timestamps: the original per-image ``created_at`` is not preserved (images get a
fresh timestamp on insert); everything else, including batch ``ingested_at`` via
the verbatim raw JSON re-save, is reproduced faithfully.
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys

# Make the src/ package importable when run as a plain script from the repo root.
_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.join(_ROOT, "src"))

from casinogurus_ai_content_engine___daily_5_topic_batch.storage import (  # noqa: E402
    init_schema,
    save_batch,
    save_image,
    summary,
)


def _open_sqlite(path: str) -> sqlite3.Connection:
    if not os.path.isfile(path):
        raise SystemExit(f"SQLite file not found: {path}")
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def migrate(sqlite_path: str) -> None:
    src = _open_sqlite(sqlite_path)
    try:
        print(f"Applying schema to target Postgres (DATABASE_URL)...")
        init_schema()

        batches = src.execute(
            "SELECT id, source, raw_json FROM batches ORDER BY id"
        ).fetchall()
        print(f"Found {len(batches)} batch(es) in {sqlite_path}.")

        id_map: dict[int, int] = {}
        for row in batches:
            data = json.loads(row["raw_json"])
            source = row["source"] or f"sqlite_migration:batch_{row['id']}"
            new_id = save_batch(data, source=source)
            id_map[row["id"]] = new_id
            pkgs = len(data.get("packages", []) or [])
            print(f"  batch {row['id']} -> {new_id}  ({pkgs} packages, source={source!r})")

        # Copy featured images for packages that now exist in Postgres.
        try:
            images = src.execute("SELECT * FROM images").fetchall()
        except sqlite3.OperationalError:
            images = []  # old DB may predate the images table
        copied = skipped = 0
        for img in images:
            pid = img["package_id"]
            try:
                save_image(
                    pid,
                    img["image_b64"],
                    prompt=img["prompt"],
                    alt_text=img["alt_text"],
                    mime_type=img["mime_type"] or "image/png",
                    model=img["model"],
                    size=img["size"],
                    status=img["status"] or "ok",
                    error=img["error"],
                )
                copied += 1
            except Exception as e:
                # A missing parent package (foreign key) just means that package
                # wasn't in any migrated batch; skip it.
                skipped += 1
                print(f"    skipped image for {pid}: {e}")
        print(f"Images: {copied} copied, {skipped} skipped.")

        print("\nMigration complete. Target now contains:")
        summary()
    finally:
        src.close()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--sqlite",
        default=os.path.join(_ROOT, "content_engine.db"),
        help="Path to the source SQLite DB (default: ./content_engine.db).",
    )
    args = ap.parse_args()
    migrate(args.sqlite)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
