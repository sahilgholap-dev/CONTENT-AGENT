"""Pydantic schema for the crew's final batch output.

Setting this as a Task's ``output_pydantic`` makes CrewAI coerce the agent's
answer into a validated object via its InternalInstructor (tool-calling) path.
That guarantees the saved output is VALID JSON even when body_html contains
double-quoted HTML attributes (href="..."), which the model otherwise fails to
escape when hand-writing JSON. The nested draft / scorecards are kept as free-form
dicts so the rich, evolving field set is preserved verbatim for storage.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class Package(BaseModel):
    # extra='allow' keeps any additional fields the task emits.
    model_config = ConfigDict(extra="allow")

    package_id: str = ""
    topic: str = ""
    primary_keyword: str = ""
    pillar: str = ""
    created_at: str = ""
    revision_count: int = 0
    review_status: str = ""
    escalation_reason: str | None = None
    reviewer_notes: str = ""
    draft: dict[str, Any] = Field(default_factory=dict)
    compliance_scorecard: dict[str, Any] = Field(default_factory=dict)
    seo_quality_scorecard: dict[str, Any] = Field(default_factory=dict)
    verification_flags: list[Any] = Field(default_factory=list)


class Batch(BaseModel):
    model_config = ConfigDict(extra="allow")

    batch_date: str = ""
    total_packages: int = 0
    ready_for_review_count: int = 0
    needs_review_count: int = 0
    packages: list[Package] = Field(default_factory=list)
