#!/usr/bin/env python
"""Seed (or re-seed) a client profile from config/clients/<client_id>.json into
the database. Idempotent per version: seeding only inserts profile version 1
if the client has no profile yet; it never overwrites an existing version
(profiles are append-only — edit via the dashboard, which bumps the version).

Usage:
    uv run python scripts/seed_client.py               # seeds casinogurus
    uv run python scripts/seed_client.py <client_id>   # seeds config/clients/<id>.json
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from casinogurus_ai_content_engine___daily_5_topic_batch import storage  # noqa: E402
from casinogurus_ai_content_engine___daily_5_topic_batch.profile import load_seed_client  # noqa: E402


def main() -> None:
    client_id = sys.argv[1] if len(sys.argv) > 1 else "casinogurus"
    record = load_seed_client(client_id)  # validates via ClientProfile

    storage.init_schema()
    storage.upsert_client(record.client_id, record.display_name, record.site_domain)

    existing = storage.get_client(record.client_id)
    if existing and existing["profile_version"] > 0:
        print(
            f"client '{record.client_id}' already has profile v{existing['profile_version']} — leaving it untouched"
        )
        return
    version = storage.insert_profile_version(
        record.client_id, record.profile.model_dump(), created_by="seed_client.py"
    )
    print(f"seeded client '{record.client_id}' with profile v{version}")


if __name__ == "__main__":
    main()
