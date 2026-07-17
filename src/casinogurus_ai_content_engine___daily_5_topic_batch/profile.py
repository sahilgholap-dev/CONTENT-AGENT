"""Per-client profile: schema, loading, and prompt-input assembly.

The client profile is the hybrid document (fixed keys, freeform team-authored
text values) stored in ``client_profiles.profile`` (JSONB) and seeded from
``config/clients/<client_id>.json``. ``build_inputs()`` is the single choke
point that turns a profile into the CrewAI kickoff inputs dict — the LangGraph
migration calls the same function.

CrewAI 1.15.2 interpolates ``{identifier}`` tokens in YAML prompts by
sequential ``str.replace`` over the inputs, and raises KeyError for tokens
with no matching input. Two guards here protect that contract:

* ``ClientProfile`` rejects profile text containing ``{identifier}`` tokens
  (they would be silently substituted or crash the kickoff).
* ``audit_yaml_placeholders()`` asserts every token used in the YAML files is
  a key ``build_inputs()`` provides — call it at startup to fail fast.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, ClassVar

import yaml
from pydantic import BaseModel, ConfigDict, field_validator

from casinogurus_ai_content_engine___daily_5_topic_batch.registry import FormatSpec

_PKG_DIR = Path(__file__).resolve().parent
_CLIENTS_DIR = _PKG_DIR / "config" / "clients"

# Matches crewai 1.15.2 (crewai/utilities/string_utils.py): a brace
# immediately followed by an identifier.
PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_\-]*)}")


def _reject_placeholder_tokens(value: Any, path: str) -> None:
    if isinstance(value, str):
        hits = sorted({m.group(1) for m in PLACEHOLDER_RE.finditer(value)})
        if hits:
            raise ValueError(
                f"profile field '{path}' contains placeholder-shaped token(s) {hits}; "
                "curly-brace identifiers would be substituted (or crash) at kickoff — rewrite without braces"
            )
    elif isinstance(value, dict):
        for k, v in value.items():
            _reject_placeholder_tokens(v, f"{path}.{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _reject_placeholder_tokens(v, f"{path}[{i}]")


class ClientProfile(BaseModel):
    """Hybrid client profile: fixed keys, freeform team-authored text values."""

    model_config = ConfigDict(extra="forbid")

    # Core team-authored fields.
    voice: str
    requirements: str = ""
    special_instructions: str = ""
    learned_style: str = ""  # written by the learning loop; human-gated

    # Pipeline text blocks injected into task prompts.
    compliance_rules: str
    topic_discovery_playbook: str
    competitor_refs: str
    content_skeletons: str
    word_count_rules: str = ""  # empty => rendered from the format's pipeline params
    self_scan_rules: str
    eeat_guidance: str
    first_use_definitions: str = ""
    mandatory_language: str
    banned_phrases: str
    seo_prechecks: str
    body_completeness_rule: str
    pillar_taxonomy: list[str]

    # Agent personas (whole backstories are client flavor; hard contracts live
    # in agent goals and task prompts, which stay in YAML).
    personas: dict[str, str]

    # Small lexical fragments used inline in otherwise-generic sentences.
    lexicon: dict[str, str]

    # Every key here becomes a YAML placeholder via build_inputs(), so a
    # missing one would crash the kickoff — require them at save time instead.
    REQUIRED_PERSONAS: ClassVar[frozenset] = frozenset(
        {
            "research_backstory", "drafter_backstory", "drafter_goal_persona",
            "compliance_backstory", "seo_checker_backstory",
            "discovery_role", "discovery_goal", "discovery_backstory",
        }
    )
    REQUIRED_LEXICON: ClassVar[frozenset] = frozenset(
        {
            "domain_noun", "domain_title", "keyword_domain",
            "content_domain_hyph", "high_risk_claim_types", "compliance_risk_hint",
        }
    )

    @field_validator("*")
    @classmethod
    def _no_placeholder_tokens(cls, v: Any, info) -> Any:
        _reject_placeholder_tokens(v, info.field_name)
        return v

    @field_validator("personas")
    @classmethod
    def _personas_complete(cls, v: dict) -> dict:
        missing = sorted(cls.REQUIRED_PERSONAS - set(v))
        if missing:
            raise ValueError(f"personas is missing required key(s): {missing}")
        return v

    @field_validator("lexicon")
    @classmethod
    def _lexicon_complete(cls, v: dict) -> dict:
        missing = sorted(cls.REQUIRED_LEXICON - set(v))
        if missing:
            raise ValueError(f"lexicon is missing required key(s): {missing}")
        return v


class ClientRecord(BaseModel):
    """A client row + its active profile, as loaded from DB or seed JSON."""

    client_id: str
    display_name: str
    site_domain: str
    profile: ClientProfile
    profile_version: int = 1


def load_seed_client(client_id: str) -> ClientRecord:
    """Load a client from its committed seed JSON (config/clients/<id>.json)."""
    path = _CLIENTS_DIR / f"{client_id}.json"
    doc = json.loads(path.read_text(encoding="utf-8"))
    return ClientRecord.model_validate(doc)


def _word_count_rules(profile: ClientProfile, format_spec: FormatSpec) -> str:
    """Profile text wins when the team authored it (keeps legacy prompts
    byte-identical); otherwise render rules from the format's pipeline params
    so new formats/clients are format-driven."""
    if profile.word_count_rules.strip():
        return profile.word_count_rules
    pipe = format_spec.pipeline or {}
    floor = pipe.get("word_floor")
    ceiling = pipe.get("word_target_max")
    if not floor and not ceiling:
        return "- No hard word-count floor for this format. Match the format directives below."
    lines = []
    if floor:
        lines.append(
            f"- HARD FLOOR: {floor:,} words of body copy. A draft below this will be REJECTED "
            "by the quality gate and sent back for expansion. Count before finalising."
        )
    if floor and ceiling:
        lines.append(f"- TARGET RANGE: {floor:,} to {ceiling:,} words.")
    elif ceiling:
        lines.append(f"- HARD CEILING: {ceiling:,} words. Trim anything longer.")
    lines.append("- Expansion must add genuine value. NEVER pad with filler or repetition.")
    return "\n".join(lines)


def _format_directives(format_spec: FormatSpec) -> str:
    """Render the format's platform directives (char limits, hashtag policy,
    tone, etc.) as prompt text. Used by format-aware task templates (e.g. the
    social_post variant); blog templates don't reference it."""
    pipe = format_spec.pipeline or {}
    lines = [f"FORMAT: {format_spec.label} ({format_spec.content_type})."]
    if format_spec.description:
        lines.append(format_spec.description)
    if pipe.get("platform"):
        lines.append(f"- Platform: {pipe['platform']}")
    if pipe.get("char_limit"):
        lines.append(
            f"- HARD LIMIT: each post_text must be at most {pipe['char_limit']} characters "
            "(count characters, not words). Posts over the limit are rejected."
        )
    if pipe.get("target_chars"):
        lines.append(f"- Target length: around {pipe['target_chars']} characters per post.")
    if "hashtags" in pipe:
        lines.append(
            f"- Hashtags: {pipe['hashtags']}" if isinstance(pipe["hashtags"], str)
            else ("- Hashtags: include a relevant hashtag set per post." if pipe["hashtags"]
                  else "- Hashtags: do NOT use hashtags.")
        )
    if pipe.get("tone"):
        lines.append(f"- Tone: {pipe['tone']}")
    for extra in pipe.get("extra_directives", []) or []:
        lines.append(f"- {extra}")
    return "\n".join(lines)


def _directives_block(profile: ClientProfile) -> str:
    """Compose the optional client-directives text appended after the voice
    store. Empty for clients with no extra directives (so legacy prompts are
    byte-identical); each populated section carries its own leading newlines."""
    parts = []
    if profile.requirements.strip():
        parts.append("CLIENT CONTENT REQUIREMENTS:\n" + profile.requirements.strip())
    if profile.special_instructions.strip():
        parts.append("SPECIAL INSTRUCTIONS (client-specific dos and don'ts):\n" + profile.special_instructions.strip())
    if profile.learned_style.strip():
        parts.append(
            "LEARNED STYLE NOTES (distilled from this client's approved articles):\n" + profile.learned_style.strip()
        )
    if not parts:
        return ""
    return "\n\n" + "\n\n".join(parts)


def build_inputs(
    client_name: str,
    client_site: str,
    profile: ClientProfile,
    format_spec: FormatSpec,
    run_context: dict | None = None,
) -> dict:
    """Assemble the complete CrewAI kickoff inputs dict.

    Every placeholder used in config/agents.yaml + config/tasks.yaml MUST be a
    key of the returned dict (see audit_yaml_placeholders). ``format_spec`` is
    accepted now so Phase-2 format placeholders slot in without a signature
    change.
    """
    pillars = profile.pillar_taxonomy
    inputs: dict[str, Any] = {
        "client_name": client_name,
        "client_site": client_site,
        "voice_store": profile.voice,
        "client_directives": _directives_block(profile),
        # Pipeline text blocks.
        "compliance_rules": profile.compliance_rules,
        "topic_discovery_playbook": profile.topic_discovery_playbook,
        "competitor_refs": profile.competitor_refs,
        "content_skeletons": profile.content_skeletons,
        "word_count_rules": _word_count_rules(profile, format_spec),
        "self_scan_rules": profile.self_scan_rules,
        "eeat_guidance": profile.eeat_guidance,
        "first_use_definitions": profile.first_use_definitions,
        "mandatory_language": profile.mandatory_language,
        "banned_phrases": profile.banned_phrases,
        "seo_prechecks": profile.seo_prechecks,
        "body_completeness_rule": profile.body_completeness_rule,
        # Deterministic renders of the pillar taxonomy.
        "pillar_enum": "|".join(f'"{p}"' for p in pillars),
        "pillar_slash_list": "/".join(pillars),
        "pillar_list_spaced": " | ".join(pillars),
        # Format identity + directives (referenced by format-aware templates).
        "content_type": format_spec.content_type,
        "format": format_spec.id,
        "format_label": format_spec.label,
        "format_directives": _format_directives(format_spec),
        "posts_per_batch": (format_spec.pipeline or {}).get("posts_per_batch", 5),
    }
    inputs.update(profile.personas)
    inputs.update(profile.lexicon)
    inputs.update(run_context or {})
    return inputs


def audit_yaml_placeholders(inputs: dict) -> None:
    """Fail fast if any {identifier} token in the YAML prompt files is not a
    provided input key (kickoff would raise KeyError mid-run otherwise)."""
    known = set(inputs)
    problems: list[str] = []
    config_dir = _PKG_DIR / "config"
    yaml_files = ["agents.yaml"] + sorted(p.name for p in config_dir.glob("tasks*.yaml"))
    for fname in yaml_files:
        data = yaml.safe_load((config_dir / fname).read_text(encoding="utf-8"))
        for section, cfg in data.items():
            for field_name, text in cfg.items():
                if not isinstance(text, str):
                    continue
                unknown = sorted({m.group(1) for m in PLACEHOLDER_RE.finditer(text)} - known)
                if unknown:
                    problems.append(f"{fname}:{section}.{field_name}: unknown placeholder(s) {unknown}")
    if problems:
        raise RuntimeError("YAML placeholder audit failed:\n  " + "\n  ".join(problems))
