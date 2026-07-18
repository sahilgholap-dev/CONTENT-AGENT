"""Create the Gemmere client from Gemmere_NEXUS_Client_Inputs.md.

Parses the ``### Heading`` + ``~~~text`` fenced blocks byte-exactly, maps them
onto ClientProfile fields, validates, writes the committed seed JSON
(config/clients/gemmere.json), and inserts the client + profile v1 into the
DB (idempotent for the client row; re-running appends a new profile version).

    uv run python scripts/create_gemmere_client.py            # dry run: validate + write seed JSON
    uv run python scripts/create_gemmere_client.py --apply    # also insert into the DB
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "Gemmere_NEXUS_Client_Inputs.md"
SEED = (
    ROOT
    / "src"
    / "casinogurus_ai_content_engine___daily_5_topic_batch"
    / "config"
    / "clients"
    / "gemmere.json"
)

# "### Heading" -> where the block's text goes.
FIELD_MAP = {
    "Brand Voice": ("profile", "voice"),
    "Compliance Rules": ("profile", "compliance_rules"),
    "Content Requirements": ("profile", "requirements"),
    "Special Instructions": ("profile", "special_instructions"),
    "Pillar Taxonomy": ("profile", "pillar_taxonomy"),
    "Topic Discovery Playbook": ("profile", "topic_discovery_playbook"),
    "Competitor Reference Tiers": ("profile", "competitor_refs"),
    "Content-Type Skeletons": ("profile", "content_skeletons"),
    "Word Count Rules": ("profile", "word_count_rules"),
    "Drafter Self-Scans": ("profile", "self_scan_rules"),
    "E-E-A-T Persona Guidance": ("profile", "eeat_guidance"),
    "First-Use Definitions": ("profile", "first_use_definitions"),
    "Mandatory Legal Language": ("profile", "mandatory_language"),
    "Banned Phrases": ("profile", "banned_phrases"),
    "SEO Gate Pre-Checks": ("profile", "seo_prechecks"),
    "Body Completeness Marker": ("profile", "body_completeness_rule"),
    "Research Specialist Backstory": ("personas", "research_backstory"),
    "Drafter Backstory": ("personas", "drafter_backstory"),
    "Drafter Goal Persona": ("personas", "drafter_goal_persona"),
    "Compliance Checker Backstory": ("personas", "compliance_backstory"),
    "SEO Checker Backstory": ("personas", "seo_checker_backstory"),
    "Discovery Agent Role": ("personas", "discovery_role"),
    "Discovery Agent Goal": ("personas", "discovery_goal"),
    "Discovery Agent Backstory": ("personas", "discovery_backstory"),
    "Domain noun (lowercase)": ("lexicon", "domain_noun"),
    "Domain noun (title case)": ("lexicon", "domain_title"),
    "Keyword domain": ("lexicon", "keyword_domain"),
    "Content domain (hyphenated)": ("lexicon", "content_domain_hyph"),
    "High-risk claim types": ("lexicon", "high_risk_claim_types"),
    "Compliance-risk scoring hint": ("lexicon", "compliance_risk_hint"),
    "Client Name": ("meta", "display_name"),
    "Site Domain": ("meta", "site_domain"),
    "Status": ("meta", "status"),
}

BLOCK_RE = re.compile(r"^### (.+?)\s*\n+~~~text\n(.*?)\n~~~", re.MULTILINE | re.DOTALL)


def parse_blocks(md: str) -> dict[str, str]:
    return {m.group(1).strip(): m.group(2) for m in BLOCK_RE.finditer(md)}


def main() -> None:
    apply = "--apply" in sys.argv
    blocks = parse_blocks(SOURCE.read_text(encoding="utf-8"))

    missing = sorted(set(FIELD_MAP) - set(blocks))
    if missing:
        raise SystemExit(f"Source document is missing expected section(s): {missing}")
    extra = sorted(set(blocks) - set(FIELD_MAP))
    if extra:
        print(f"NOTE: unmapped section(s) ignored: {extra}")

    meta: dict[str, str] = {}
    profile: dict = {"learned_style": ""}
    personas: dict[str, str] = {}
    lexicon: dict[str, str] = {}
    buckets = {"meta": meta, "profile": profile, "personas": personas, "lexicon": lexicon}
    for heading, (bucket, key) in FIELD_MAP.items():
        text = blocks[heading].strip()
        if key == "pillar_taxonomy":
            profile[key] = [line.strip() for line in text.splitlines() if line.strip()]
        else:
            buckets[bucket][key] = text
    profile["personas"] = personas
    profile["lexicon"] = lexicon

    from casinogurus_ai_content_engine___daily_5_topic_batch.profile import ClientProfile

    validated = ClientProfile.model_validate(profile)  # raises on any schema problem
    print(f"Profile validates: {len(profile['pillar_taxonomy'])} pillars, "
          f"{len(personas)} personas, {len(lexicon)} lexicon keys.")

    client_id = "gemmere"
    record = {
        "client_id": client_id,
        "display_name": meta["display_name"],
        "site_domain": meta["site_domain"],
        "profile": validated.model_dump(),
        "profile_version": 1,
    }
    SEED.write_text(json.dumps(record, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Seed written: {SEED.relative_to(ROOT)}")

    if not apply:
        print("\nDry run only. Re-run with --apply to insert into the database.")
        return

    from casinogurus_ai_content_engine___daily_5_topic_batch import storage

    existing = storage.get_client(client_id)
    storage.upsert_client(client_id, meta["display_name"], meta["site_domain"], meta.get("status", "active"))
    version = storage.insert_profile_version(client_id, validated.model_dump(), created_by="create_gemmere_client.py")
    print(f"DB: client '{client_id}' {'updated' if existing else 'created'}; profile v{version} inserted.")


if __name__ == "__main__":
    main()
