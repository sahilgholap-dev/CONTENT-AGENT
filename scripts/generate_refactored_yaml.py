
#!/usr/bin/env python
"""One-off: regenerate config/agents.yaml + config/tasks.yaml as client-neutral
templates, mechanically, from the pre-refactor baseline prompt dump and the
extracted casinogurus profile.

Approach: take each baseline prompt text (which IS today's exact interpolated
prompt) and substitute every profile text block / lexical fragment back into a
{placeholder}. Because the substitutions are exact string replacements of the
same values build_inputs() provides, interpolating the generated templates
with the casinogurus profile reproduces the baseline byte-for-byte — which
scripts/regression_prompt_diff.py then proves.

Whole-field placeholders (agent backstories, discovery role/goal) are emitted
directly. Multi-line fields are emitted as YAML literal blocks (|-), so the
generated files stay human-editable.
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

_ROOT = Path(__file__).resolve().parent.parent
_BASE = _ROOT / "runs" / "baseline_prompts"
_PKG_DIR = _ROOT / "src" / "casinogurus_ai_content_engine___daily_5_topic_batch"
_CONFIG = _PKG_DIR / "config"


def _read(name: str) -> str:
    return (_BASE / f"{name}.txt").read_text(encoding="utf-8")


def main() -> None:
    doc = json.loads((_CONFIG / "clients" / "casinogurus.json").read_text(encoding="utf-8"))
    p = doc["profile"]
    personas, lexicon = p["personas"], p["lexicon"]
    pillars = p["pillar_taxonomy"]

    # Ordered: longest/most-specific first so no rule corrupts a later one.
    replacements: list[tuple[str, str]] = [
        (p["voice"], "{voice_store}{client_directives}"),
        (p["topic_discovery_playbook"], "{topic_discovery_playbook}"),
        (p["compliance_rules"], "{compliance_rules}"),
        (p["competitor_refs"], "{competitor_refs}"),
        (p["content_skeletons"], "{content_skeletons}"),
        (p["self_scan_rules"], "{self_scan_rules}"),
        (p["word_count_rules"], "{word_count_rules}"),
        (p["seo_prechecks"], "{seo_prechecks}"),
        (p["eeat_guidance"], "{eeat_guidance}"),
        (p["mandatory_language"], "{mandatory_language}"),
        (p["banned_phrases"], "{banned_phrases}"),
        (p["first_use_definitions"], "{first_use_definitions}"),
        (p["body_completeness_rule"], "{body_completeness_rule}"),
        (personas["drafter_goal_persona"], "{drafter_goal_persona}"),
        ("|".join(f'"{x}"' for x in pillars), "{pillar_enum}"),
        (" | ".join(pillars), "{pillar_list_spaced}"),
        ("/".join(pillars), "{pillar_slash_list}"),
        ("casinogurus.org", "{client_site}"),
        ("CasinoGurus", "{client_name}"),
        (lexicon["keyword_domain"], "{keyword_domain}"),
        (lexicon["content_domain_hyph"], "{content_domain_hyph}"),
        (lexicon["high_risk_claim_types"], "{high_risk_claim_types}"),
        (lexicon["compliance_risk_hint"], "{compliance_risk_hint}"),
        ("If sample_value is provided", "If {revision_feedback} is provided"),
        ("revision_count: sample_value", "revision_count: {revision_count}"),
        ("escalation_reason: sample_value", "escalation_reason: {escalation_reason}"),
        ("Casino", "{domain_title}"),
        ("casino", "{domain_noun}"),
    ]

    def templatise(text: str) -> str:
        for needle, token in replacements:
            if needle:
                text = text.replace(needle, token)
        return text

    # Fields that become a single whole-field placeholder.
    whole_field = {
        ("casino_seo_research_grounding_specialist", "backstory"): "{research_backstory}",
        ("casinogurus_grounded_article_drafter", "backstory"): "{drafter_backstory}",
        ("casino_content_compliance_mandate_checker", "backstory"): "{compliance_backstory}",
        ("casino_content_seo_quality_checker", "backstory"): "{seo_checker_backstory}",
        ("casino_content_topic_discovery_specialist", "role"): "{discovery_role}",
        ("casino_content_topic_discovery_specialist", "goal"): "{discovery_goal}",
        ("casino_content_topic_discovery_specialist", "backstory"): "{discovery_backstory}",
    }

    def block(text: str, indent: int = 4) -> str:
        pad = " " * indent
        return "\n".join((pad + line) if line else "" for line in text.split("\n"))

    # --- agents.yaml ---
    agents = yaml.safe_load((_CONFIG / "agents.yaml").read_text(encoding="utf-8"))
    lines = ["---"]
    for agent_name in agents:
        lines.append(f"{agent_name}:")
        for field in ("role", "goal", "backstory"):
            text = whole_field.get((agent_name, field)) or templatise(_read(f"agent__{agent_name}__{field}"))
            lines.append(f"  {field}: |-")
            lines.append(block(text))
    (_CONFIG / "agents.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("wrote agents.yaml")

    # --- tasks.yaml ---
    tasks = yaml.safe_load((_CONFIG / "tasks.yaml").read_text(encoding="utf-8"))
    lines = ["---"]
    for task_name, cfg in tasks.items():
        lines.append(f"{task_name}:")
        for field in ("description", "expected_output"):
            lines.append(f"  {field}: |-")
            lines.append(block(templatise(_read(f"task__{task_name}__{field}"))))
        lines.append(f"  agent: {cfg['agent']}")
        if cfg.get("async_execution"):
            lines.append("  async_execution: true")
        if cfg.get("context"):
            lines.append("  context:")
            for dep in cfg["context"]:
                lines.append(f"  - {dep}")
    (_CONFIG / "tasks.yaml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("wrote tasks.yaml")

    # Sanity: no client string survived into the templates.
    leftovers = []
    for fname in ("agents.yaml", "tasks.yaml"):
        text = (_CONFIG / fname).read_text(encoding="utf-8")
        for bad in ("casino", "Casino", "{client_name}gurus", "BeGambleAware", "PlayAmo", "BitStarz"):
            # task/agent KEYS legitimately contain 'casino'; check values only via crude filter
            for i, line in enumerate(text.split("\n"), 1):
                if bad in line and not line.rstrip().endswith(":") and "agent:" not in line and "- " + bad.lower() not in line:
                    leftovers.append(f"{fname}:{i}: {line.strip()[:90]}")
    if leftovers:
        print("NOTE: client-specific strings still present (review these):")
        for x in leftovers:
            print("  " + x)


if __name__ == "__main__":
    main()
