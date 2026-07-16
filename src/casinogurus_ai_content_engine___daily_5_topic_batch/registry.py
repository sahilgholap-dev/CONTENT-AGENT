"""Content-type / format registry.

The DB tables ``content_types`` and ``formats`` (see schema.sql) are the runtime
source of truth, managed via the API / the dashboard's "Content Types & Formats"
master. The defaults below seed those tables the first time they are empty
(storage.seed_registry_defaults) and act as an offline fallback when no database
is reachable.

A format's *pipeline behaviour* is chosen by ``task_variant`` — that is code
(only ``"default"`` exists today, the 6-task blog crew). Everything else about a
format (label, description, enabled, word counts, stage labels) is editable data.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class FormatSpec:
    id: str                      # stored on batches.format
    content_type: str            # "long_form" | "short_form"; stored on batches.content_type
    label: str                   # shown in UI selectors
    description: str
    enabled: bool = True         # disabled formats are hidden from /api/formats
    # Backend-internal pipeline params (never serialised to the run modal).
    pipeline: dict = field(default_factory=dict)
    # Ordered pipeline stage names — drives the terminal progress UI via the
    # [AGENT_RUN] log header.
    stage_labels: list = field(default_factory=list)


# Task variants that actually exist in the pipeline code. A format may only be
# saved against one of these (the API validates it). New variants require a new
# task-template branch in the crew.
AVAILABLE_TASK_VARIANTS: list[str] = ["default"]


# Seed data. content_type id -> label.
DEFAULT_CONTENT_TYPES: dict[str, str] = {
    "long_form": "Long-form",
    "short_form": "Short-form",
}

DEFAULT_FORMATS: dict[str, FormatSpec] = {
    "blog": FormatSpec(
        id="blog",
        content_type="long_form",
        label="Blog Article",
        description="Long-form SEO blog article (1,200-1,500 words) with compliance and SEO gates.",
        enabled=True,
        pipeline={
            "task_variant": "default",
            "packages_per_batch": 1,
            "word_floor": 1200,
            "word_target_max": 1500,
        },
        stage_labels=[
            "Topic Discovery",
            "Keyword & Competitor Analysis",
            "Drafting Article",
            "Compliance Check",
            "SEO & Quality Check",
            "Assembling Draft Package",
        ],
    ),
}


def spec_from_row(row: dict) -> FormatSpec:
    """Build a FormatSpec from a ``formats`` DB row (dict). ``task_variant`` is
    folded into ``pipeline`` so downstream code has one place to read it."""
    pipeline = dict(row.get("pipeline") or {})
    pipeline.setdefault("task_variant", row.get("task_variant", "default"))
    return FormatSpec(
        id=row["id"],
        content_type=row["content_type"],
        label=row.get("label") or row["id"],
        description=row.get("description") or "",
        enabled=bool(row.get("enabled", True)),
        pipeline=pipeline,
        stage_labels=list(row.get("stage_labels") or []),
    )


def get_format(format_id: str) -> FormatSpec:
    """Offline/code fallback lookup (used only when the DB is unreachable).
    The live path is storage.resolve_format_spec / storage.get_format_row."""
    return DEFAULT_FORMATS[format_id]
