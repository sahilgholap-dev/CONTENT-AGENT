"""Learning loop: distil reviewer feedback into a learned_style proposal.

Flow (human-gated — see schema.sql `learning_proposals`):

    package_reviews (append-only events, written by the FeedbackBar)
        └─> distill_client(client_id)
                reads events past the watermark + the reviewed articles,
                calls Claude once to REWRITE the learned_style addendum,
                parks the result as a pending learning_proposal
        └─> admin reviews/edits in the dashboard and accepts
                └─> insert_profile_version(..., learned_style=proposed)
                        └─> profile.py injects it into every agent prompt

The addendum is rewritten (not appended) on every distill and capped so it
stays a small, sharp set of rules rather than an ever-growing list.
"""

from __future__ import annotations

import os
import re

from casinogurus_ai_content_engine___daily_5_topic_batch import storage

# One distill call analyses at most this many review events.
MAX_EVENTS = 60
# Ask the model to stay under this; hard cap a little above it.
TARGET_CHARS = 1500
HARD_CAP_CHARS = 2200
# Fewer events than this and the distiller refuses — one grumpy rejection
# shouldn't rewrite a client's style rules.
MIN_EVENTS = 3

_MODEL = os.environ.get("LEARNING_MODEL", "claude-opus-4-8")

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


def _strip_html(html: str | None, cap: int = 1200) -> str:
    if not html:
        return ""
    return _WS_RE.sub(" ", _TAG_RE.sub(" ", html)).strip()[:cap]


def _render_event(e: dict) -> str:
    parts = [
        f"### Review #{e['id']} — {e['action'].upper()}",
        f"Topic: {e.get('topic') or '(unknown)'} | Pillar: {e.get('pillar') or '-'}",
        f"Title: {e.get('seo_title') or '-'}",
    ]
    if e.get("feedback"):
        parts.append(f"Reviewer notes: {e['feedback']}")
    if e.get("excerpt"):
        parts.append(f"Excerpt: {e['excerpt']}")
    body = _strip_html(e.get("body_sample"))
    if body:
        parts.append(f"Article sample: {body}")
    return "\n".join(parts)


_SYSTEM = """You distil editorial feedback into style rules for an AI content pipeline.

You are given review decisions (approved / rejected / shortlisted, with optional
reviewer notes) on articles written for one client, plus the client's CURRENT
learned-style addendum. Produce the UPDATED addendum: a complete REWRITE that
merges what still holds from the current addendum with what the new feedback
shows. It is injected verbatim into the article writer's prompt.

Rules for the addendum you write:
- Concrete, actionable do/don't rules only ("Open with a factual statement,
  never a superlative"), each on its own "- " bullet line.
- Derive rules from evidence: explicit reviewer notes first, then consistent
  patterns across approved vs rejected articles. Never invent a rule a single
  ambiguous data point can't support.
- Drop rules from the current addendum that new feedback contradicts.
- At most 12 bullets and under {target} characters total. Fewer, sharper rules
  beat many vague ones.
- Output ONLY the addendum bullets — no preamble, headings, or commentary.
- If the feedback supports no defensible rule changes, output the current
  addendum unchanged (or nothing if it is empty).""".format(target=TARGET_CHARS)


def distill_client(client_id: str) -> dict:
    """Run one distillation pass for a client and park a pending proposal.

    Returns {"status": "proposed", "proposal": row} on success, or
    {"status": "skipped", "reason": ...} when there's nothing useful to do.
    Raises on API/storage errors so the endpoint can 502 them.
    """
    client = storage.get_client(client_id)
    if not client or not client.get("profile"):
        return {"status": "skipped", "reason": f"client '{client_id}' has no profile"}
    current = (client["profile"].get("learned_style") or "").strip()

    watermark = storage.learning_watermark(client_id)
    events = storage.feedback_events_since(client_id, watermark, limit=MAX_EVENTS)
    if len(events) < MIN_EVENTS:
        return {
            "status": "skipped",
            "reason": f"only {len(events)} new review event(s) since watermark "
                      f"{watermark}; need at least {MIN_EVENTS}",
        }

    voice = (client["profile"].get("voice") or "")[:800]
    prompt = "\n\n".join(
        [
            f"Client: {client.get('display_name') or client_id}",
            f"Client voice (for context, do not restate it as rules):\n{voice}" if voice else "",
            f"CURRENT learned-style addendum:\n{current or '(empty)'}",
            f"NEW review events ({len(events)}):\n\n" + "\n\n".join(_render_event(e) for e in events),
            "Write the updated learned-style addendum now.",
        ]
    ).strip()

    import anthropic

    resp = anthropic.Anthropic().messages.create(
        model=_MODEL,
        max_tokens=4000,
        thinking={"type": "adaptive"},
        system=_SYSTEM,
        messages=[{"role": "user", "content": prompt}],
    )
    if resp.stop_reason == "refusal":
        return {"status": "skipped", "reason": "model declined the distillation request"}
    proposed = next((b.text for b in resp.content if b.type == "text"), "").strip()
    if len(proposed) > HARD_CAP_CHARS:
        # Truncate on a bullet boundary rather than mid-rule.
        cut = proposed.rfind("\n- ", 0, HARD_CAP_CHARS)
        proposed = proposed[: cut if cut > 0 else HARD_CAP_CHARS].strip()

    if not proposed and not current:
        return {"status": "skipped", "reason": "model produced no rules from the feedback"}
    if proposed == current:
        return {"status": "skipped", "reason": "no changes proposed — current rules still hold"}

    proposal = storage.create_learning_proposal(
        client_id=client_id,
        proposed_text=proposed,
        current_text=current,
        last_review_id=events[-1]["id"],
        review_count=len(events),
    )
    return {"status": "proposed", "proposal": proposal}
