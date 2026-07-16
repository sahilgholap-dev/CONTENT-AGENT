#!/usr/bin/env python
"""One-off: build config/clients/casinogurus.json by slicing the pre-refactor
baseline prompt dump (runs/baseline_prompts). Slicing the interpolated dumps —
rather than hand-copying — guarantees the profile text blocks are byte-exact,
which is what makes scripts/regression_prompt_diff.py able to prove the
placeholder refactor changed nothing.

Run AFTER `regression_prompt_diff.py dump runs/baseline_prompts` on the
pre-refactor tree. Idempotent; overwrites the JSON.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
_BASE = _ROOT / "runs" / "baseline_prompts"
_OUT = _ROOT / "src" / "casinogurus_ai_content_engine___daily_5_topic_batch" / "config" / "clients" / "casinogurus.json"


def _read(name: str) -> str:
    return (_BASE / f"{name}.txt").read_text(encoding="utf-8")


def _slice(text: str, start: str, end: str | None = None) -> str:
    i = text.index(start)
    if end is None:
        return text[i:]
    j = text.index(end, i)
    return text[i : j + len(end)]


def main() -> None:
    if not _BASE.exists():
        sys.exit("ERROR: runs/baseline_prompts missing — run regression_prompt_diff.py dump first")

    disc = _read("task__discover_daily_casino_topics__description")
    keyw = _read("task__keyword_research_and_competitor_analysis__description")
    draft = _read("task__draft_casino_article__description")
    comp = _read("task__compliance_gate_check__description")
    seo = _read("task__seo_and_quality_gate_check__description")
    asm = _read("task__assemble_draft_package_for_review_queue__description")

    profile = {
        # --- core hybrid fields (team-authored) ---
        "voice": _slice(disc, "WHO WE ARE:", None).split("\n\nTHE SINGLE TOPIC TEST")[0],
        "requirements": "",
        "special_instructions": "",
        "learned_style": "",
        # --- pipeline text blocks (byte-exact from today's YAML) ---
        "compliance_rules": _slice(comp, "**BONUS ACCURACY", "NEVER appears in blocking_failures.**"),
        "topic_discovery_playbook": _slice(disc, "THE SINGLE TOPIC TEST", None),
        "competitor_refs": _slice(keyw, "Use these reference tiers:", "coinspeaker.com/bitcoin-casinos."),
        "content_skeletons": _slice(draft, "**CONTENT TYPE — classify FIRST", "how to stay safe."),
        "word_count_rules": _slice(draft, "- HARD FLOOR:", "never cut FAQ or Conclusion."),
        "self_scan_rules": _slice(draft, "**MANDATORY SELF-SCANS", "properly closed."),
        "eeat_guidance": _slice(
            draft,
            "**WRITE LIKE A REAL US CRYPTO-GAMBLING EXPERT",
            "replace them with specifics whenever the facts allow.",
        ),
        "first_use_definitions": _slice(draft, '- Define "wagering requirement', "FIRST USE ONLY per article"),
        "mandatory_language": _slice(draft, "A) Affiliate disclosure", '0808 8020 133."'),
        "banned_phrases": _slice(draft, '- "risk-free" / "risk free" / "riskfree"', '"opportunity to win real money"'),
        "seo_prechecks": _slice(seo, "1. DASH CHECK:", "never below the floor."),
        "body_completeness_rule": _slice(asm, "must end with complete Conclusion", "BeGambleAware.org"),
        "pillar_taxonomy": ["reviews", "bonuses", "crypto", "guides", "regional"],
        # --- agent personas (whole backstories are client flavor; contracts live in goals/tasks) ---
        "personas": {
            "research_backstory": _read("agent__casino_seo_research_grounding_specialist__backstory"),
            "drafter_backstory": _read("agent__casinogurus_grounded_article_drafter__backstory"),
            "drafter_goal_persona": _slice(
                _read("agent__casinogurus_grounded_article_drafter__goal"),
                "Write like a real US crypto-gambling expert",
                None,
            ),
            "compliance_backstory": _read("agent__casino_content_compliance_mandate_checker__backstory"),
            "seo_checker_backstory": _read("agent__casino_content_seo_quality_checker__backstory"),
            "discovery_role": _read("agent__casino_content_topic_discovery_specialist__role"),
            "discovery_goal": _read("agent__casino_content_topic_discovery_specialist__goal"),
            "discovery_backstory": _read("agent__casino_content_topic_discovery_specialist__backstory"),
        },
        # --- small lexical fragments used inline in otherwise-generic sentences ---
        "lexicon": {
            "domain_noun": "casino",
            "domain_title": "Casino",
            "keyword_domain": "casino/gambling",
            "content_domain_hyph": "casino-content",
            "high_risk_claim_types": "bonus amounts, licensing, payout speed, or legality",
            "compliance_risk_hint": "how much RG/legal/bonus caution is needed",
        },
    }

    _OUT.parent.mkdir(parents=True, exist_ok=True)
    doc = {
        "client_id": "casinogurus",
        "display_name": "CasinoGurus",
        "site_domain": "casinogurus.org",
        "profile": profile,
    }
    _OUT.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {_OUT}")
    for key, val in profile.items():
        if isinstance(val, str):
            print(f"  {key}: {len(val)} chars")
        elif isinstance(val, dict):
            print(f"  {key}: {len(val)} entries")
        else:
            print(f"  {key}: {val!r}")


if __name__ == "__main__":
    main()
