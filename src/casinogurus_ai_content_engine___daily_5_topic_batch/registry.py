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
#   default      -> 6-task long-form blog crew (config/tasks.yaml)
#   social_post  -> 5-task short-form social crew (config/tasks_social.yaml);
#                   platform specifics come from the format's pipeline params.
#   video_script -> 5-task video-script crew (config/tasks_video.yaml); duration,
#                   orientation and scene granularity come from pipeline params.
AVAILABLE_TASK_VARIANTS: list[str] = ["default", "social_post", "video_script"]


# Seed data. content_type id -> label.
DEFAULT_CONTENT_TYPES: dict[str, str] = {
    "long_form": "Long-form",
    "short_form": "Short-form",
    "video": "Video",
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

_SOCIAL_STAGES = [
    "Topic Discovery",
    "Research & Fact Store",
    "Drafting Posts",
    "Compliance Check",
    "Assembling Package",
]

DEFAULT_FORMATS.update(
    {
        "instagram_caption": FormatSpec(
            id="instagram_caption",
            content_type="short_form",
            label="Instagram Caption",
            description="Scroll-stopping Instagram captions with hashtags, fact-grounded and compliance-checked.",
            enabled=True,
            pipeline={
                "task_variant": "social_post",
                "posts_per_batch": 5,
                "platform": "Instagram",
                "char_limit": 2200,
                "target_chars": 500,
                "hashtags": "include 5-10 relevant hashtags per post, placed at the end of post_text",
                "tone": "punchy, visual-first, first line must hook before the fold",
            },
            stage_labels=list(_SOCIAL_STAGES),
        ),
        "linkedin_post": FormatSpec(
            id="linkedin_post",
            content_type="short_form",
            label="LinkedIn Post",
            description="Professional LinkedIn posts with a strong hook and clear takeaway.",
            enabled=True,
            pipeline={
                "task_variant": "social_post",
                "posts_per_batch": 5,
                "platform": "LinkedIn",
                "char_limit": 3000,
                "target_chars": 1200,
                "hashtags": "at most 3 professional hashtags at the very end",
                "tone": "professional, insight-led, short paragraphs with line breaks, no hype",
            },
            stage_labels=list(_SOCIAL_STAGES),
        ),
        "facebook_caption": FormatSpec(
            id="facebook_caption",
            content_type="short_form",
            label="Facebook Caption",
            description="Conversational Facebook captions that invite engagement.",
            enabled=True,
            pipeline={
                "task_variant": "social_post",
                "posts_per_batch": 5,
                "platform": "Facebook",
                "char_limit": 2000,
                "target_chars": 400,
                "hashtags": "0-3 hashtags only when genuinely relevant",
                "tone": "conversational, community-minded, ends with a question or clear CTA",
            },
            stage_labels=list(_SOCIAL_STAGES),
        ),
    }
)


_VIDEO_STAGES = [
    "Topic Discovery",
    "Research & Fact Store",
    "Writing Scripts",
    "Compliance Check",
    "Assembling Package",
]

DEFAULT_FORMATS.update(
    {
        "youtube_short": FormatSpec(
            id="youtube_short",
            content_type="video",
            label="YouTube Short / Reel",
            description="60-90 second vertical video scripts: hook-first, scene-by-scene voiceover with on-screen text and visual directions.",
            enabled=True,
            pipeline={
                "task_variant": "video_script",
                "scripts_per_batch": 2,
                "platform": "YouTube Shorts / Instagram Reels",
                "orientation": "vertical 9:16",
                "duration_min_sec": 60,
                "duration_max_sec": 90,
                "scene_length_rule": "3-8 seconds per scene; every scene has voiceover, on-screen text and a visual direction",
                "tone": "fast, punchy, hook lands in the first 2 seconds, one idea per video, no filler",
            },
            stage_labels=list(_VIDEO_STAGES),
        ),
        "youtube_long": FormatSpec(
            id="youtube_long",
            content_type="video",
            label="YouTube Video (5-10 min)",
            description="Chaptered long-form YouTube scripts with B-roll directions, retention hooks between chapters and an outro CTA.",
            enabled=True,
            pipeline={
                "task_variant": "video_script",
                "scripts_per_batch": 2,
                "platform": "YouTube",
                "orientation": "landscape 16:9",
                "duration_min_sec": 300,
                "duration_max_sec": 600,
                "scene_length_rule": "chapters of 45-90 seconds, each broken into scenes; every scene has voiceover, on-screen text and a visual/B-roll direction",
                "tone": "expert, conversational, retention-focused with an open loop into each next chapter, no hype",
            },
            stage_labels=list(_VIDEO_STAGES),
        ),
    }
)


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
