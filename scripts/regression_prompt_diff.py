#!/usr/bin/env python
"""Prompt-equivalence regression gate for the multi-client refactor.

CrewAI 1.15.2 interpolates YAML prompts with a plain sequential ``str.replace``
over the kickoff inputs (crewai/utilities/string_utils.py::interpolate_only),
so prompt equivalence between the hardcoded CasinoGurus pipeline and the
profile-driven pipeline is checkable WITHOUT any LLM run:

  1. On the pre-refactor tree:   python scripts/regression_prompt_diff.py dump runs/baseline_prompts
  2. On the post-refactor tree:  python scripts/regression_prompt_diff.py dump runs/refactored_prompts
  3.                             python scripts/regression_prompt_diff.py compare runs/baseline_prompts runs/refactored_prompts

The dump auto-detects which tree it is on: if the seeded client profile
(config/clients/casinogurus.json + profile.py) exists, inputs come from
profile.build_inputs(); otherwise from main.py's CASINOGURUS_VOICE constant
(read via AST so this script never imports crewai).

An empty compare (exit 0) means every interpolated agent role/goal/backstory
and task description/expected_output is byte-identical.
"""
from __future__ import annotations

import ast
import difflib
import json
import re
import sys
from pathlib import Path

import yaml

_SCRIPTS_DIR = Path(__file__).resolve().parent
_PROJECT_ROOT = _SCRIPTS_DIR.parent
_PKG = "casinogurus_ai_content_engine___daily_5_topic_batch"
_PKG_DIR = _PROJECT_ROOT / "src" / _PKG
_CONFIG_DIR = _PKG_DIR / "config"

# Matches crewai 1.15.2: a brace immediately followed by an identifier.
_PLACEHOLDER_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_\-]*)}")

# The run-context values main.py has always passed alongside the profile text.
_RUN_CONTEXT = {
    "revision_feedback": "sample_value",
    "revision_count": "sample_value",
    "escalation_reason": "sample_value",
}


def _interpolate(text: str, inputs: dict) -> str:
    """Replicates crewai.utilities.string_utils.interpolate_only semantics:
    sequential str.replace per input key; unknown leftover placeholders are an
    error (crewai raises KeyError at kickoff)."""
    for key, value in inputs.items():
        text = text.replace("{" + key + "}", str(value))
    leftover = sorted({m.group(1) for m in _PLACEHOLDER_RE.finditer(text)} - _KNOWN_LITERALS)
    if leftover:
        raise SystemExit(f"ERROR: uninterpolated placeholder(s) {leftover} — kickoff would raise KeyError")
    return text


# Identifier-shaped tokens that legitimately appear in prompt text without being
# placeholders (none today; extend deliberately if a prompt ever needs one).
_KNOWN_LITERALS: set[str] = set()


def _voice_from_main_py() -> str:
    """Read CASINOGURUS_VOICE from main.py via AST (avoids importing crewai)."""
    tree = ast.parse((_PKG_DIR / "main.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id == "CASINOGURUS_VOICE" for t in node.targets
        ):
            value = node.value
            # Pattern: """...""".strip()
            if (
                isinstance(value, ast.Call)
                and isinstance(value.func, ast.Attribute)
                and value.func.attr == "strip"
                and isinstance(value.func.value, ast.Constant)
            ):
                return value.func.value.value.strip()
            if isinstance(value, ast.Constant):
                return value.value
    raise SystemExit("ERROR: CASINOGURUS_VOICE not found in main.py")


def _build_inputs() -> tuple[dict, str]:
    """Return (inputs, mode). Post-refactor mode wins when the profile exists."""
    profile_json = _CONFIG_DIR / "clients" / "casinogurus.json"
    if profile_json.exists() and (_PKG_DIR / "profile.py").exists():
        sys.path.insert(0, str(_PROJECT_ROOT / "src"))
        from casinogurus_ai_content_engine___daily_5_topic_batch.profile import (  # noqa: E402
            ClientProfile,
            build_inputs,
        )
        from casinogurus_ai_content_engine___daily_5_topic_batch.registry import (  # noqa: E402
            get_format,
        )

        profile = ClientProfile.model_validate(json.loads(profile_json.read_text(encoding="utf-8"))["profile"])
        inputs = build_inputs(
            client_name="CasinoGurus",
            client_site="casinogurus.org",
            profile=profile,
            format_spec=get_format("blog"),
            run_context=dict(_RUN_CONTEXT),
        )
        return inputs, "profile"
    inputs = {"voice_store": _voice_from_main_py(), **_RUN_CONTEXT}
    return inputs, "legacy"


def dump(out_dir: Path) -> None:
    inputs, mode = _build_inputs()
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.txt"):
        old.unlink()

    agents = yaml.safe_load((_CONFIG_DIR / "agents.yaml").read_text(encoding="utf-8"))
    tasks = yaml.safe_load((_CONFIG_DIR / "tasks.yaml").read_text(encoding="utf-8"))

    count = 0
    for name, cfg in agents.items():
        for field in ("role", "goal", "backstory"):
            text = _interpolate(str(cfg.get(field, "")), inputs)
            (out_dir / f"agent__{name}__{field}.txt").write_text(text, encoding="utf-8")
            count += 1
    for name, cfg in tasks.items():
        for field in ("description", "expected_output"):
            text = _interpolate(str(cfg.get(field, "")), inputs)
            (out_dir / f"task__{name}__{field}.txt").write_text(text, encoding="utf-8")
            count += 1
    print(f"[{mode} mode] dumped {count} interpolated prompt fields to {out_dir}")


def compare(baseline: Path, refactored: Path) -> int:
    base_files = {p.name for p in baseline.glob("*.txt")}
    new_files = {p.name for p in refactored.glob("*.txt")}
    failures = 0
    for missing in sorted(base_files - new_files):
        print(f"MISSING in refactored dump: {missing}")
        failures += 1
    for added in sorted(new_files - base_files):
        print(f"EXTRA in refactored dump: {added}")
        failures += 1
    for name in sorted(base_files & new_files):
        a = (baseline / name).read_text(encoding="utf-8")
        b = (refactored / name).read_text(encoding="utf-8")
        if a != b:
            failures += 1
            print(f"DIFF: {name}")
            for line in difflib.unified_diff(
                a.splitlines(), b.splitlines(), fromfile=f"baseline/{name}", tofile=f"refactored/{name}", lineterm=""
            ):
                print(f"  {line}")
    if failures:
        print(f"\n{failures} prompt field(s) differ — the refactor is NOT byte-equivalent.")
        return 1
    print(f"OK: all {len(base_files)} interpolated prompt fields are byte-identical.")
    return 0


def main() -> None:
    if len(sys.argv) >= 3 and sys.argv[1] == "dump":
        dump(Path(sys.argv[2]))
    elif len(sys.argv) >= 4 and sys.argv[1] == "compare":
        sys.exit(compare(Path(sys.argv[2]), Path(sys.argv[3])))
    else:
        print(__doc__)
        sys.exit(2)


if __name__ == "__main__":
    main()
