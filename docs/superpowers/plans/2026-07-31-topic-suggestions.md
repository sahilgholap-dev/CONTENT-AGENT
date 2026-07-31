# Topic Suggestions (suggest → shortlist → generate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users request research-grounded topic suggestions (with an optional taste hint), shortlist up to the format's per-run limit, and generate one piece of content per selected topic — alongside the renamed "Discover automatically & generate" mode.

**Architecture:** A suggest run is a new `kind` of row in the existing `runs` table, executed by a new discovery-only crew variant that saves rows to a new `topic_suggestions` table instead of a batch. Selected suggestions launch a normal generate run with a pinned `topics` JSON list; social/video prompts write one post/script per pinned topic via a `{pinned_topics_directive}` input and a `posts_per_batch`/`scripts_per_batch` override.

**Tech Stack:** FastAPI + psycopg (Supabase Postgres), CrewAI 1.15.2 (YAML task configs), Next.js 16 + React (frontend), pytest via `uv run pytest tests/`.

**Spec:** `docs/superpowers/specs/2026-07-31-topic-suggestions-design.md`

## Global Constraints

- Git: commit to `main` locally; NEVER push (the user pushes; canonical remote is `main` → CONTENT-AGENT.git).
- Windows/PowerShell environment; run Python via `uv run`, tests via `uv run pytest tests/ -v`.
- schema.sql is split naively on semicolons and comment-stripped — never put a `;` or `--` inside a string literal there; all DDL must be idempotent (`IF NOT EXISTS`).
- Every `{identifier}` token in `config/agents.yaml` + every `config/tasks*.yaml` MUST be a key `build_inputs()` returns, or `audit_yaml_placeholders` fails at kickoff for EVERY run.
- Profile/topic/hint text must never contain `{identifier}`-shaped tokens (CrewAI interpolates them). Suggested-topic strings are agent-produced: normalize `{`/`}` to `(`/`)` before insert.
- Frontend is Next.js 16 (breaking changes vs training data — see `frontend/AGENTS.md`). These tasks only edit existing component patterns and `lib/api.ts`; if you need any new Next API, read `frontend/node_modules/next/dist/docs/` first.
- End commit messages with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- The local backend on :8000 enforces real Supabase auth (`AUTH_DISABLED=0` in `.env`). E2E calls mint an admin JWT from `SUPABASE_JWT_SECRET` (see Task 8).

---

### Task 1: Schema + storage primitives for suggestions and run kind/topics

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/schema.sql` (append after line 135, the `ALTER TABLE runs ADD COLUMN IF NOT EXISTS topic TEXT;` block)
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/storage.py` (runs section, lines ~505-560)

**Interfaces:**
- Consumes: existing `connection()`, `Jsonb` (already imported in storage.py), `uuid`.
- Produces (later tasks rely on these exact names):
  - `create_run(client_id, content_type, format, topic=None, kind="generate", topics=None) -> dict`
  - `save_topic_suggestions(run_row: dict, items: list[dict]) -> int`
  - `list_topic_suggestions(client_id: str, format: str, status: str = "suggested", limit: int = 50) -> list[dict]`
  - `get_topic_suggestions_by_ids(ids: list[str]) -> list[dict]`
  - `set_suggestions_status(ids: list[str], status: str, generate_run_id: str | None = None) -> None`
  - `revert_selected_suggestions(generate_run_id: str) -> None`
  - `mark_generated_suggestions(generate_run_id: str) -> None`
  - `recent_suggestion_topics(client_id: str, format: str, limit: int = 50) -> list[str]`
  - `recent_package_topics(client_id: str, limit: int = 100) -> list[str]`

- [ ] **Step 1: Append the DDL to schema.sql**

Add after the existing `ALTER TABLE runs ADD COLUMN IF NOT EXISTS topic TEXT;` line:

```sql
-- Suggest-vs-generate runs. kind='suggest' executes the discovery-only crew
-- and saves rows to topic_suggestions instead of a batch. For suggest runs
-- the topic column carries the optional user taste hint. topics is the
-- pinned topic list for generate runs launched from a suggestion shortlist.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'generate';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS topics JSONB;

-- One row per suggested topic. status: suggested -> selected -> generated
-- (reverted to suggested when the linked generate run fails).
CREATE TABLE IF NOT EXISTS topic_suggestions (
    id              UUID PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    content_type    TEXT NOT NULL,
    format          TEXT NOT NULL,
    topic           TEXT NOT NULL,
    pillar          TEXT,
    primary_keyword TEXT,
    search_intent   TEXT,
    rationale       TEXT,
    hint            TEXT,
    suggest_run_id  UUID,
    status          TEXT NOT NULL DEFAULT 'suggested',
    generate_run_id UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suggestions_client_fmt
    ON topic_suggestions(client_id, format, status, created_at DESC);
```

- [ ] **Step 2: Extend `create_run` in storage.py**

Replace the existing `create_run` (line ~509) with:

```python
def create_run(
    client_id: str,
    content_type: str,
    format: str,
    topic: str | None = None,
    kind: str = "generate",
    topics: list[str] | None = None,
) -> dict:
    """Insert a queued run pinned to the client's current profile version.

    kind='suggest' runs the discovery-only suggestion crew (topic = taste
    hint). topics is the pinned topic list for shortlist-launched generate
    runs (one piece of content per topic)."""
    with connection() as conn:
        prof = conn.execute(
            "SELECT COALESCE(MAX(version), 0) AS v FROM client_profiles WHERE client_id = %s",
            (client_id,),
        ).fetchone()
        version = prof["v"]
        if not version:
            raise ValueError(f"client '{client_id}' has no profile version to run against")
        run_id = str(uuid.uuid4())
        row = conn.execute(
            """INSERT INTO runs (id, client_id, profile_version, content_type, format, topic, kind, topics)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
               RETURNING *""",
            (run_id, client_id, version, content_type, format, topic, kind,
             Jsonb(list(topics)) if topics else None),
        ).fetchone()
        return dict(row)
```

- [ ] **Step 3: Add the suggestion storage functions**

Add a new section after `list_runs` (line ~558):

```python
# ---------------------------------------------------------------------------
# Topic suggestions (suggest -> shortlist -> generate)
# ---------------------------------------------------------------------------

def _sanitize_topic(text: str) -> str:
    """Suggested topics are agent-produced and get interpolated into prompts
    later; a brace token would be substituted (or crash) at kickoff."""
    return (text or "").strip().replace("{", "(").replace("}", ")")


def save_topic_suggestions(run_row: dict, items: list[dict]) -> int:
    """Insert one topic_suggestions row per suggested topic from a suggest
    run. Skips items with an empty topic. Returns rows inserted."""
    inserted = 0
    with connection() as conn:
        for it in items:
            topic = _sanitize_topic(it.get("topic") or "")
            if not topic:
                continue
            conn.execute(
                """INSERT INTO topic_suggestions
                   (id, client_id, content_type, format, topic, pillar,
                    primary_keyword, search_intent, rationale, hint, suggest_run_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (str(uuid.uuid4()), run_row["client_id"], run_row["content_type"],
                 run_row["format"], topic, it.get("pillar"), it.get("primary_keyword"),
                 it.get("search_intent"), it.get("rationale"), run_row.get("topic"),
                 str(run_row["id"])),
            )
            inserted += 1
    return inserted


def list_topic_suggestions(
    client_id: str, format: str, status: str = "suggested", limit: int = 50
) -> list[dict]:
    with connection() as conn:
        rows = conn.execute(
            """SELECT * FROM topic_suggestions
               WHERE client_id = %s AND format = %s AND status = %s
               ORDER BY created_at DESC LIMIT %s""",
            (client_id, format, status, limit),
        ).fetchall()
        return [dict(r) for r in rows]


def get_topic_suggestions_by_ids(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    with connection() as conn:
        rows = conn.execute(
            "SELECT * FROM topic_suggestions WHERE id = ANY(%s)", (list(ids),)
        ).fetchall()
        return [dict(r) for r in rows]


def set_suggestions_status(ids: list[str], status: str, generate_run_id: str | None = None) -> None:
    if not ids:
        return
    with connection() as conn:
        conn.execute(
            "UPDATE topic_suggestions SET status = %s, generate_run_id = %s WHERE id = ANY(%s)",
            (status, generate_run_id, list(ids)),
        )


def revert_selected_suggestions(generate_run_id: str) -> None:
    """A failed shortlist run releases its topics for retry."""
    with connection() as conn:
        conn.execute(
            """UPDATE topic_suggestions SET status = 'suggested', generate_run_id = NULL
               WHERE generate_run_id = %s AND status = 'selected'""",
            (generate_run_id,),
        )


def mark_generated_suggestions(generate_run_id: str) -> None:
    with connection() as conn:
        conn.execute(
            """UPDATE topic_suggestions SET status = 'generated'
               WHERE generate_run_id = %s AND status = 'selected'""",
            (generate_run_id,),
        )


def recent_suggestion_topics(client_id: str, format: str, limit: int = 50) -> list[str]:
    """Avoid-list input for the next suggestion round (any status)."""
    with connection() as conn:
        rows = conn.execute(
            """SELECT topic FROM topic_suggestions
               WHERE client_id = %s AND format = %s
               ORDER BY created_at DESC LIMIT %s""",
            (client_id, format, limit),
        ).fetchall()
        return [r["topic"] for r in rows]


def recent_package_topics(client_id: str, limit: int = 100) -> list[str]:
    """Recently produced content topics for this client (all formats)."""
    with connection() as conn:
        rows = conn.execute(
            """SELECT p.topic FROM packages p
               WHERE p.client_id = %s AND p.topic IS NOT NULL AND p.topic <> ''
               ORDER BY p.created_at DESC LIMIT %s""",
            (client_id, limit),
        ).fetchall()
        return [r["topic"] for r in rows]
```

- [ ] **Step 4: Apply and verify the schema against the local DB**

PowerShell mangles nested quotes in `python -c`; write a throwaway check script to the session scratchpad directory (any path outside the repo) as `check_schema.py`:

```python
from casinogurus_ai_content_engine___daily_5_topic_batch.storage import init_schema
from casinogurus_ai_content_engine___daily_5_topic_batch.db import connection

init_schema()
with connection() as conn:
    cols = [
        r["column_name"]
        for r in conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name='runs'"
        ).fetchall()
    ]
    assert "kind" in cols and "topics" in cols, cols
    t = conn.execute("SELECT to_regclass('topic_suggestions') AS t").fetchone()["t"]
    assert t == "topic_suggestions", t
print("schema OK")
```

Run: `uv run python <scratchpad>\check_schema.py`
Expected: `schema OK`. (Additive/idempotent — the deployed server applies the same statements on next boot.)

- [ ] **Step 5: Commit**

```powershell
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/schema.sql src/casinogurus_ai_content_engine___daily_5_topic_batch/storage.py
git commit -m @'
feat(storage): runs.kind/topics + topic_suggestions table and helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 2: `max_per_run` in the registry and the formats payload

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/registry.py` (append function at end)
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/storage.py:877-899` (`serialisable_registry`)
- Test: `tests/test_topic_suggestions.py` (new file)

**Interfaces:**
- Consumes: `FormatSpec` (registry.py), `spec_from_row(row)`.
- Produces: `registry.max_per_run(spec: FormatSpec) -> int`; every format object in `GET /api/formats` / `GET /api/portal/formats` gains `"max_per_run": int`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_topic_suggestions.py`:

```python
"""Unit tests for the topic-suggestion feature's pure helpers.

No database or Supabase needed: registry caps, prompt-directive rendering,
kickoff-input overrides, suggest-output parsing, and selection validation.
"""

from casinogurus_ai_content_engine___daily_5_topic_batch import registry


# ------------------------------- max_per_run ------------------------------ #

def test_max_per_run_blog_is_1():
    assert registry.max_per_run(registry.DEFAULT_FORMATS["blog"]) == 1


def test_max_per_run_linkedin_is_5():
    assert registry.max_per_run(registry.DEFAULT_FORMATS["linkedin_post"]) == 5


def test_max_per_run_video_uses_scripts_per_batch():
    assert registry.max_per_run(registry.DEFAULT_FORMATS["youtube_short"]) == 2


def test_max_per_run_empty_pipeline_defaults_to_1():
    spec = registry.FormatSpec(id="x", content_type="long_form", label="X", description="")
    assert registry.max_per_run(spec) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_topic_suggestions.py -v`
Expected: FAIL with `AttributeError: module ... has no attribute 'max_per_run'`

- [ ] **Step 3: Implement `max_per_run` in registry.py**

Append at the end of registry.py:

```python
def max_per_run(spec: FormatSpec) -> int:
    """How many pieces of content one run of this format may produce — the
    shortlist selection cap. Multi-piece variants declare posts_per_batch /
    scripts_per_batch in their pipeline params; everything else is 1."""
    pipe = spec.pipeline or {}
    return int(pipe.get("posts_per_batch") or pipe.get("scripts_per_batch") or 1)
```

- [ ] **Step 4: Expose it in `serialisable_registry`**

In storage.py `serialisable_registry` (line ~883), the per-format dict gains one key. Add a module-level import is NOT needed — the function already lives in a module that imports registry lazily elsewhere; import inside the function like `resolve_format_spec` does:

```python
def serialisable_registry(enabled_only: bool = True) -> dict:
    """Content types with their (optionally enabled-only) formats nested, for
    cascading selectors. ``pipeline`` params stay backend-internal (only the
    derived max_per_run cap is exposed for the shortlist UI)."""
    from casinogurus_ai_content_engine___daily_5_topic_batch import registry

    cts = list_content_types()
    formats = list_formats(enabled_only=enabled_only)
    by_ct: dict[str, list] = {}
    for f in formats:
        by_ct.setdefault(f["content_type"], []).append(
            {
                "id": f["id"],
                "label": f["label"],
                "description": f["description"],
                "enabled": f["enabled"],
                "stage_labels": list(f.get("stage_labels") or []),
                "max_per_run": registry.max_per_run(registry.spec_from_row(f)),
            }
        )
    out = []
    for ct in cts:
        items = by_ct.get(ct["id"], [])
        if enabled_only and not items:
            continue  # hide empty categories from the run modal
        out.append({"id": ct["id"], "label": ct["label"], "formats": items})
    return {"content_types": out}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_topic_suggestions.py -v`
Expected: 4 PASS

- [ ] **Step 6: Commit**

```powershell
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/registry.py src/casinogurus_ai_content_engine___daily_5_topic_batch/storage.py tests/test_topic_suggestions.py
git commit -m @'
feat(registry): max_per_run cap exposed in the formats payload

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 3: Prompt directives + kickoff-input plumbing in profile.py

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/profile.py` (after `_topic_directive`, line ~252; and `build_inputs`, lines ~254-305)
- Test: `tests/test_topic_suggestions.py` (extend)

**Interfaces:**
- Consumes: existing `_topic_directive`, `build_inputs`, `FormatSpec`.
- Produces:
  - `_pinned_topics_directive(topics: list[str] | None) -> str` (empty string when no topics)
  - `suggestion_directive(hint: str | None, avoid: list[str]) -> str` (public: main.py uses it)
  - `build_inputs(..., topics: list[str] | None = None)` — new keyword param; new always-present input keys `pinned_topics_directive`, `suggestion_directive` (default `""`), `suggestion_count` (default `10`); `posts_per_batch`/`scripts_per_batch` become `len(topics)` when topics are pinned.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_topic_suggestions.py`:

```python
from casinogurus_ai_content_engine___daily_5_topic_batch.profile import (
    _pinned_topics_directive,
    build_inputs,
    load_seed_client,
    suggestion_directive,
)


# -------------------------- _pinned_topics_directive ----------------------- #

def test_pinned_directive_empty_for_none_and_blank():
    assert _pinned_topics_directive(None) == ""
    assert _pinned_topics_directive([]) == ""
    assert _pinned_topics_directive(["  ", ""]) == ""


def test_pinned_directive_numbers_topics_and_sets_count():
    d = _pinned_topics_directive(["Topic A", "Topic B", "Topic C"])
    assert "1. Topic A" in d and "2. Topic B" in d and "3. Topic C" in d
    assert "EXACTLY the 3 topics" in d
    assert "one piece of content per topic" in d


# ---------------------------- suggestion_directive ------------------------- #

def test_suggestion_directive_empty_when_no_hint_no_avoid():
    assert suggestion_directive(None, []) == ""
    assert suggestion_directive("  ", []) == ""


def test_suggestion_directive_renders_hint_and_avoid_list():
    d = suggestion_directive("gift guide topics", ["Old Topic 1", "Old Topic 2"])
    assert 'gift guide topics' in d
    assert "- Old Topic 1" in d and "- Old Topic 2" in d
    assert "do NOT repeat" in d


# ------------------------------- build_inputs ------------------------------ #

def _seed_inputs(**kwargs):
    record = load_seed_client("casinogurus")
    spec = registry.DEFAULT_FORMATS["linkedin_post"]
    return build_inputs(
        client_name=record.display_name,
        client_site=record.site_domain,
        profile=record.profile,
        format_spec=spec,
        run_context={"revision_feedback": "x", "revision_count": "x", "escalation_reason": "x"},
        **kwargs,
    )


def test_build_inputs_defaults_for_new_keys():
    inputs = _seed_inputs()
    assert inputs["pinned_topics_directive"] == ""
    assert inputs["suggestion_directive"] == ""
    assert inputs["suggestion_count"] == 10
    assert inputs["posts_per_batch"] == 5  # linkedin default untouched


def test_build_inputs_topics_override_posts_per_batch():
    inputs = _seed_inputs(topics=["T1", "T2", "T3"])
    assert inputs["posts_per_batch"] == 3
    assert inputs["scripts_per_batch"] == 3
    assert "1. T1" in inputs["pinned_topics_directive"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_topic_suggestions.py -v`
Expected: new tests FAIL with `ImportError: cannot import name '_pinned_topics_directive'`

- [ ] **Step 3: Implement the two directives and extend build_inputs**

Insert after `_topic_directive` (line ~252) in profile.py:

```python
def _pinned_topics_directive(topics: list[str] | None) -> str:
    """Render the pinned-shortlist block for generate runs launched from a
    suggestion shortlist. Empty string when no topics are pinned, so all
    other runs' prompts stay byte-identical (same pattern as
    _topic_directive)."""
    topics = [t.strip() for t in (topics or []) if t and t.strip()]
    if not topics:
        return ""
    n = len(topics)
    numbered = "\n".join(f"{i + 1}. {t}" for i, t in enumerate(topics))
    return (
        f"\n\nPINNED TOPIC LIST (mandatory — {n} topics chosen by the editorial team):\n"
        f"{numbered}\n"
        "These rules OVERRIDE any theme-based instructions in this task:\n"
        f"- This batch covers EXACTLY the {n} topics above, in this order: "
        "one piece of content per topic.\n"
        "- Do NOT run topic discovery, do NOT substitute, merge or drop topics, "
        "and do NOT invent additional ones.\n"
        "- Each pinned topic is that piece's angle AND its final topic string: "
        "wherever a field asks for the topic (or a 'Theme — Angle' composite), "
        "use the pinned topic text verbatim instead.\n"
        "- Research and grounding must cover EVERY pinned topic individually; "
        "a fact store entry may serve one or several topics.\n"
        "- You may search the web only to sharpen keywords, facts and angles "
        "for these topics, never to replace them."
    )


def suggestion_directive(hint: str | None, avoid: list[str]) -> str:
    """Render the round-specific block for suggest runs: the user's taste
    hint (if any) plus the already-covered avoid-list. Empty when neither
    exists. Injected as the {suggestion_directive} input."""
    parts = []
    hint = (hint or "").strip()
    if hint:
        parts.append(
            "USER TASTE HINT (mandatory steer): the editorial team asked for "
            f'topics like: "{hint}". Weight every suggestion toward this '
            "request while staying inside the client's lane rules."
        )
    avoid = [t.strip() for t in (avoid or []) if t and t.strip()]
    if avoid:
        listing = "\n".join(f"- {t}" for t in avoid)
        parts.append(
            "ALREADY COVERED OR SUGGESTED (do NOT repeat or lightly reword "
            "any of these):\n" + listing
        )
    return "\n\n".join(parts)
```

In `build_inputs`: add the keyword param and keys. Signature becomes:

```python
def build_inputs(
    client_name: str,
    client_site: str,
    profile: ClientProfile,
    format_spec: FormatSpec,
    run_context: dict | None = None,
    topic: str | None = None,
    topics: list[str] | None = None,
) -> dict:
```

Inside, replace the two `*_per_batch` lines and add the new keys (keep every existing key unchanged):

```python
    n_pinned = len([t for t in (topics or []) if t and t.strip()])
    inputs: dict[str, Any] = {
        ...existing keys unchanged...
        # Empty in discover mode; a mandatory-topic block in user-topic mode.
        "topic_directive": _topic_directive(topic),
        # Empty unless a shortlist pinned this run's topics.
        "pinned_topics_directive": _pinned_topics_directive(topics),
        # Non-empty only for suggest runs (main.py passes it via run_context).
        "suggestion_directive": "",
        "suggestion_count": 10,
        ...
        "posts_per_batch": n_pinned or (format_spec.pipeline or {}).get("posts_per_batch", 5),
        "scripts_per_batch": n_pinned or (format_spec.pipeline or {}).get("scripts_per_batch", 2),
    }
```

(`run_context` is merged LAST via `inputs.update(run_context or {})`, which is what lets main.py override `suggestion_directive` for suggest runs — do not reorder.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/test_topic_suggestions.py -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```powershell
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/profile.py tests/test_topic_suggestions.py
git commit -m @'
feat(profile): pinned-topics + suggestion directives in kickoff inputs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 4: Suggest crew variant + pinned-directive injection into social/video YAML

**Files:**
- Create: `src/casinogurus_ai_content_engine___daily_5_topic_batch/config/tasks_suggest.yaml`
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/models.py` (append)
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/crew.py` (new crew class + `CREW_BY_VARIANT`)
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/config/tasks_social.yaml` (4 descriptions)
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/config/tasks_video.yaml` (4 descriptions)
- Test: `tests/test_topic_suggestions.py` (extend)

**Interfaces:**
- Consumes: `build_inputs` defaults from Task 3 (`suggestion_directive`, `suggestion_count`, `pinned_topics_directive`); existing agent `casino_content_topic_discovery_specialist`; `_make_agent`, `_haiku_llm`, `_log_task_progress`, `BoundedExaSearchTool` in crew.py.
- Produces:
  - `models.TopicSuggestionItem` (fields: `topic, pillar, primary_keyword, search_intent, rationale`, extra allowed) and `models.TopicSuggestionBatch` (field: `suggestions: list[TopicSuggestionItem]`)
  - `crew.SuggestTopicsCrew` registered as `CREW_BY_VARIANT["suggest"]`

- [ ] **Step 1: Write the failing audit test**

Append to `tests/test_topic_suggestions.py`:

```python
from casinogurus_ai_content_engine___daily_5_topic_batch.profile import audit_yaml_placeholders


def test_yaml_placeholder_audit_passes_with_default_inputs():
    """Every {token} in agents.yaml + ALL tasks*.yaml (including the new
    tasks_suggest.yaml and the pinned-directive injections) must be a
    build_inputs key — this is exactly the check every kickoff runs."""
    audit_yaml_placeholders(_seed_inputs())


def test_suggest_crew_variant_registered():
    from casinogurus_ai_content_engine___daily_5_topic_batch.crew import CREW_BY_VARIANT
    assert "suggest" in CREW_BY_VARIANT
```

- [ ] **Step 2: Run tests to verify the variant test fails**

Run: `uv run pytest tests/test_topic_suggestions.py -v -k "suggest_crew or audit"`
Expected: `test_suggest_crew_variant_registered` FAILS (KeyError/assert); the audit test PASSES so far (nothing new in YAML yet) — it becomes the regression net for Steps 3-5.

- [ ] **Step 3: Create `config/tasks_suggest.yaml`**

```yaml
---
# Discovery-only suggestion pipeline (run kind: suggest). ONE task: propose a
# shortlist of individual content topics for one client + format. Output is
# saved to the topic_suggestions table, never to batches/packages.
suggest_topics:
  description: |-
    Propose exactly {suggestion_count} DISTINCT content topic suggestions for {client_name} for the "{format_label}" format. Determine today's date automatically; do not rely on any input variable for this.

    VOICE & BRAND CONTEXT:
    {voice_store}{client_directives}

    OUTPUT FORMAT CONTEXT (every suggested topic must suit this format):
    {format_directives}

    TOPIC DISCOVERY GUIDANCE (apply the audience tests, lane rules, seed queries, reject filters and uniqueness checks from the client's playbook to EVERY suggestion):
    {topic_discovery_playbook}

    {suggestion_directive}

    SUGGESTION REQUIREMENTS:
    - Every suggestion is ONE individual piece of content (one article, one post, or one script) — never a theme for multiple pieces.
    - Suggestions must be meaningfully different from each other: different questions, audiences, occasions or angles, not rewordings of one idea.
    - Search the web for current search language and demand before finalising the list.
    - Each topic string must read as a publishable, consumer-facing title.
    - rationale: ONE sentence on why this topic deserves to exist for this client (who searches it and what they get).
    - Never use curly braces in any output string.
  expected_output: |-
    A JSON object, and nothing else:
    {
      "suggestions": [
        {
          "topic": str,
          "pillar": {pillar_enum},
          "primary_keyword": str,
          "search_intent": "informational"|"commercial"|"transactional",
          "rationale": str
        }
      ]
    }
    The suggestions array contains exactly {suggestion_count} entries.
  agent: casino_content_topic_discovery_specialist
```

- [ ] **Step 4: Add the output models to models.py**

Append to models.py:

```python
class TopicSuggestionItem(BaseModel):
    model_config = ConfigDict(extra="allow")

    topic: str = ""
    pillar: str = ""
    primary_keyword: str = ""
    search_intent: str = ""
    rationale: str = ""


class TopicSuggestionBatch(BaseModel):
    """Validated output of the suggest crew's single task (same
    output_pydantic coercion pattern as Batch)."""

    model_config = ConfigDict(extra="allow")

    suggestions: list[TopicSuggestionItem] = Field(default_factory=list)
```

- [ ] **Step 5: Add `SuggestTopicsCrew` to crew.py and register the variant**

Change the models import at the top of crew.py to:

```python
from casinogurus_ai_content_engine___daily_5_topic_batch.models import Batch, TopicSuggestionBatch
```

Insert before the `CREW_BY_VARIANT` dict:

```python
@CrewBase
class SuggestTopicsCrew:
    """Discovery-only crew (run kind: suggest). One agent, one task from
    config/tasks_suggest.yaml: propose a shortlist of topics for one
    client+format. No drafting/compliance/SEO stages — a round costs a
    single web-searching agent."""

    tasks_config = "config/tasks_suggest.yaml"

    @agent
    def casino_content_topic_discovery_specialist(self) -> Agent:
        # Bounded Exa search keeps context under Haiku's 200K window.
        return _make_agent(
            self.agents_config["casino_content_topic_discovery_specialist"],
            [BoundedExaSearchTool()],
            _haiku_llm(),
        )

    @task
    def suggest_topics(self) -> Task:
        return Task(
            config=self.tasks_config["suggest_topics"],
            markdown=False,
            # Coerce into valid JSON via CrewAI's tool-calling path, exactly
            # like Batch for the content crews.
            output_pydantic=TopicSuggestionBatch,
        )

    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=False,
            chat_llm=_haiku_llm(),
            task_callback=_log_task_progress,
        )
```

And extend the map:

```python
CREW_BY_VARIANT = {
    "default": CasinogurusAiContentEngineDaily5TopicBatchCrew,
    "social_post": SocialPostCrew,
    "video_script": VideoScriptCrew,
    # Not a format task_variant: selected by main.py when run.kind == 'suggest'.
    "suggest": SuggestTopicsCrew,
}
```

- [ ] **Step 6: Inject `{pinned_topics_directive}` into the social and video task YAML**

In `config/tasks_social.yaml`:
1. `discover_social_topics` description, first line: change `...{topic_directive}` to `...{topic_directive}{pinned_topics_directive}`
2. `social_research_grounding` description: append a final line `{pinned_topics_directive}` (after the "Keep it light..." paragraph, separated by a blank line)
3. `draft_social_posts` description: append a final line `{pinned_topics_directive}` (after the OUTPUT DISCIPLINE paragraph, separated by a blank line)
4. `assemble_social_package` description: append a final line `{pinned_topics_directive}` (after the HARD STOP line, separated by a blank line)

In `config/tasks_video.yaml`, the same four injections on: `discover_video_topics` (after `{topic_directive}` on its first line), `video_research_grounding`, `draft_video_scripts`, `assemble_video_package` (each: append `{pinned_topics_directive}` as a final paragraph).

The directive is `""` for every run without pinned topics, so all existing prompts stay byte-identical.

- [ ] **Step 7: Run the full test file**

Run: `uv run pytest tests/test_topic_suggestions.py -v`
Expected: all PASS (the audit test now also proves the new YAML tokens resolve).

- [ ] **Step 8: Commit**

```powershell
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/config/tasks_suggest.yaml src/casinogurus_ai_content_engine___daily_5_topic_batch/config/tasks_social.yaml src/casinogurus_ai_content_engine___daily_5_topic_batch/config/tasks_video.yaml src/casinogurus_ai_content_engine___daily_5_topic_batch/models.py src/casinogurus_ai_content_engine___daily_5_topic_batch/crew.py tests/test_topic_suggestions.py
git commit -m @'
feat(crew): discovery-only suggest variant + pinned-topics prompt injection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 5: main.py — suggest-run branch, topics resolution, status transitions

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/main.py`
- Test: `tests/test_topic_suggestions.py` (extend)

**Interfaces:**
- Consumes: `storage.recent_suggestion_topics`, `storage.recent_package_topics`, `storage.save_topic_suggestions`, `storage.revert_selected_suggestions`, `storage.mark_generated_suggestions` (Task 1); `profile.suggestion_directive`, `build_inputs(topics=...)` (Task 3); `CREW_BY_VARIANT["suggest"]` (Task 4).
- Produces: `_suggestion_items(result) -> list[dict]` (module-level, pure — tests import it).

- [ ] **Step 1: Write the failing tests for `_suggestion_items`**

Append to `tests/test_topic_suggestions.py`:

```python
import json
from types import SimpleNamespace

from casinogurus_ai_content_engine___daily_5_topic_batch.main import _suggestion_items
from casinogurus_ai_content_engine___daily_5_topic_batch.models import (
    TopicSuggestionBatch,
    TopicSuggestionItem,
)


# ------------------------------ _suggestion_items -------------------------- #

def test_suggestion_items_prefers_pydantic_output():
    obj = TopicSuggestionBatch(suggestions=[
        TopicSuggestionItem(topic="A", pillar="p", rationale="r"),
        TopicSuggestionItem(topic="  "),  # blank topic dropped
    ])
    result = SimpleNamespace(pydantic=obj, raw="")
    items = _suggestion_items(result)
    assert [i["topic"] for i in items] == ["A"]


def test_suggestion_items_parses_raw_json_dict():
    raw = json.dumps({"suggestions": [{"topic": "B", "pillar": "x"}, {"topic": ""}]})
    result = SimpleNamespace(pydantic=None, raw=raw)
    assert [i["topic"] for i in _suggestion_items(result)] == ["B"]


def test_suggestion_items_parses_raw_json_list():
    raw = json.dumps([{"topic": "C"}])
    result = SimpleNamespace(pydantic=None, raw=raw)
    assert [i["topic"] for i in _suggestion_items(result)] == ["C"]


def test_suggestion_items_malformed_returns_empty():
    assert _suggestion_items(SimpleNamespace(pydantic=None, raw="not json {")) == []
    assert _suggestion_items(SimpleNamespace(pydantic=None, raw=json.dumps({"x": 1}))) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_topic_suggestions.py -v -k suggestion_items`
Expected: FAIL with `ImportError: cannot import name '_suggestion_items'`

- [ ] **Step 3: Implement in main.py**

Add `import json` to the imports and `suggestion_directive` to the profile import list:

```python
from casinogurus_ai_content_engine___daily_5_topic_batch.profile import (
    ClientProfile,
    audit_yaml_placeholders,
    build_inputs,
    load_seed_client,
    suggestion_directive,
)
```

Add the module-level parser (after `_dump_raw_output`):

```python
def _suggestion_items(result) -> list[dict]:
    """Suggestion dicts from a suggest-crew result: the coerced pydantic
    output when present, else best-effort JSON from the raw text. Items
    without a topic are dropped; [] means the round is unusable."""
    obj = getattr(result, "pydantic", None)
    if obj is not None and getattr(obj, "suggestions", None):
        return [i.model_dump() for i in obj.suggestions if (i.topic or "").strip()]
    try:
        data = json.loads(getattr(result, "raw", None) or str(result))
    except Exception:
        return []
    items = data.get("suggestions") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    return [i for i in items if isinstance(i, dict) and (i.get("topic") or "").strip()]
```

In `_resolve_run`, inside the `if run_id:` branch, replace the inputs/variant block (after `spec = _resolve_spec(run_row["format"])`) with:

```python
        variant = (spec.pipeline or {}).get("task_variant", "default")
        run_context = dict(_RUN_CONTEXT)

        # Shortlist-launched generate runs pin a topic LIST. The blog crew is
        # single-piece, so its (always length-1) list collapses onto the
        # existing single-topic path and tasks.yaml needs no changes.
        topic = run_row.get("topic")
        topics = list(run_row.get("topics") or []) or None
        if topics and variant == "default":
            topic, topics = topics[0], None

        if run_row.get("kind") == "suggest":
            variant = "suggest"
            avoid = storage.recent_suggestion_topics(
                run_row["client_id"], run_row["format"], limit=50
            ) + storage.recent_package_topics(run_row["client_id"], limit=100)
            # For suggest runs the topic column carries the taste hint.
            run_context["suggestion_directive"] = suggestion_directive(topic, avoid)
            topic, topics = None, None

        inputs = build_inputs(
            client_name=client["display_name"],
            client_site=client["site_domain"],
            profile=profile,
            format_spec=spec,
            run_context=run_context,
            topic=topic,
            topics=topics,
        )
        return run_row, inputs, variant
```

In `run()`, after the `result = crew_cls().crew().kickoff(...)` try/except block, insert the suggest-save branch BEFORE the existing `_dump_raw_output(result)` line:

```python
    if run_row and run_row.get("kind") == "suggest":
        _dump_raw_output(result)
        items = _suggestion_items(result)
        if not items:
            storage.update_run(
                run_row["id"], status="failed",
                error="suggest run produced no parseable suggestions (raw output dumped to runs/)",
                finished_at=datetime.now(timezone.utc),
            )
        else:
            n = storage.save_topic_suggestions(run_row, items)
            print(f"[suggest] Saved {n} topic suggestions for client '{run_row['client_id']}'.")
            storage.update_run(
                run_row["id"], status="succeeded", finished_at=datetime.now(timezone.utc)
            )
        return result
```

Also wire the suggestion status transitions for shortlist generate runs:
- In the kickoff `except` handler AND in the "crew succeeded but save failed" handler, after each `storage.update_run(..., status="failed", ...)` add:

```python
            if run_row.get("topics"):
                storage.revert_selected_suggestions(str(run_row["id"]))
```

- After the successful `storage.update_run(run_row["id"], status="succeeded", ...)` in the save path add:

```python
            if run_row.get("topics"):
                storage.mark_generated_suggestions(str(run_row["id"]))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `uv run pytest tests/ -v`
Expected: all PASS (including the pre-existing 13 portal-scope tests).

- [ ] **Step 5: Commit**

```powershell
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/main.py tests/test_topic_suggestions.py
git commit -m @'
feat(main): suggest-run branch, pinned-topics resolution, status flips

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 6: API endpoints (admin + portal) and selection validation

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py`
- Test: `tests/test_topic_suggestions.py` (extend)

**Interfaces:**
- Consumes: `_start_agent_run` (app.py:918), `_portal_cid`, `require_client`, `storage.get_topic_suggestions_by_ids`, `storage.list_topic_suggestions`, `storage.set_suggestions_status`, `storage.resolve_format_spec`, `registry.max_per_run`.
- Produces:
  - `_validate_suggestion_selection(rows, suggestion_ids, client_id, cap) -> tuple[str, str, list[str]]` (pure; raises `HTTPException(422)`; returns `(content_type, format, ordered_topics)`)
  - Admin routes: `POST /api/suggest-topics`, `GET /api/topic-suggestions`, `POST /api/generate-from-suggestions`
  - Portal routes: `POST /api/portal/suggest-topics`, `GET /api/portal/topic-suggestions`, `POST /api/portal/generate-from-suggestions`
  - `_start_agent_run(client_id, content_type, format_id, raw_topic, kind="generate", topics=None)`

- [ ] **Step 1: Write the failing tests for the pure validator**

Append to `tests/test_topic_suggestions.py`:

```python
import pytest
from fastapi import HTTPException

from casinogurus_ai_content_engine___daily_5_topic_batch.app import (
    _validate_suggestion_selection,
)


def _rows():
    return [
        {"id": "s1", "client_id": "frugaa", "content_type": "short_form",
         "format": "linkedin_post", "status": "suggested", "topic": "T1"},
        {"id": "s2", "client_id": "frugaa", "content_type": "short_form",
         "format": "linkedin_post", "status": "suggested", "topic": "T2"},
        {"id": "s3", "client_id": "frugaa", "content_type": "long_form",
         "format": "blog", "status": "suggested", "topic": "T3"},
        {"id": "s4", "client_id": "frugaa", "content_type": "short_form",
         "format": "linkedin_post", "status": "generated", "topic": "T4"},
    ]


# ------------------------ _validate_suggestion_selection ------------------- #

def test_selection_happy_path_preserves_order():
    ct, fmt, topics = _validate_suggestion_selection(_rows(), ["s2", "s1"], "frugaa", 5)
    assert (ct, fmt) == ("short_form", "linkedin_post")
    assert topics == ["T2", "T1"]


def test_selection_empty_is_422():
    with pytest.raises(HTTPException) as e:
        _validate_suggestion_selection(_rows(), [], "frugaa", 5)
    assert e.value.status_code == 422


def test_selection_unknown_id_is_422():
    with pytest.raises(HTTPException) as e:
        _validate_suggestion_selection(_rows(), ["nope"], "frugaa", 5)
    assert e.value.status_code == 422


def test_selection_wrong_client_is_422():
    with pytest.raises(HTTPException) as e:
        _validate_suggestion_selection(_rows(), ["s1"], "gemmere", 5)
    assert e.value.status_code == 422


def test_selection_mixed_formats_is_422():
    with pytest.raises(HTTPException) as e:
        _validate_suggestion_selection(_rows(), ["s1", "s3"], "frugaa", 5)
    assert e.value.status_code == 422


def test_selection_already_used_is_422():
    with pytest.raises(HTTPException) as e:
        _validate_suggestion_selection(_rows(), ["s4"], "frugaa", 5)
    assert e.value.status_code == 422


def test_selection_over_cap_is_422():
    with pytest.raises(HTTPException) as e:
        _validate_suggestion_selection(_rows(), ["s1", "s2"], "frugaa", 1)
    assert e.value.status_code == 422


def test_selection_duplicate_ids_is_422():
    with pytest.raises(HTTPException) as e:
        _validate_suggestion_selection(_rows(), ["s1", "s1"], "frugaa", 5)
    assert e.value.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `uv run pytest tests/test_topic_suggestions.py -v -k selection`
Expected: FAIL with `ImportError: cannot import name '_validate_suggestion_selection'`
(If importing `app` fails for an unrelated env reason, fix the import error — the module has no import-time DB connection.)

- [ ] **Step 3: Implement in app.py**

Add `registry` to the existing registry import (app.py currently imports `AVAILABLE_TASK_VARIANTS` from it):

```python
from casinogurus_ai_content_engine___daily_5_topic_batch import registry
```

Request models (next to `RunAgentRequest`/`PortalRunRequest`, app.py:89-131):

```python
class SuggestTopicsRequest(BaseModel):
    client_id: str = "casinogurus"
    content_type: str = "long_form"
    format: str = "blog"
    # Optional taste hint steering the round ("what kind of topics do you
    # have in mind"); validated like a topic (length + no brace tokens).
    hint: str | None = None


class PortalSuggestTopicsRequest(BaseModel):
    """Portal twin: client_id comes from the JWT, never the body."""

    content_type: str = "long_form"
    format: str = "blog"
    hint: str | None = None


class GenerateFromSuggestionsRequest(BaseModel):
    client_id: str = "casinogurus"
    suggestion_ids: list[str]


class PortalGenerateFromSuggestionsRequest(BaseModel):
    suggestion_ids: list[str]
```

Extend `_start_agent_run` (app.py:918). Signature:

```python
def _start_agent_run(
    client_id: str,
    content_type: str,
    format_id: str,
    raw_topic: str | None,
    kind: str = "generate",
    topics: list[str] | None = None,
) -> dict:
```

Three edits inside it:
1. `create_run` call becomes:

```python
    run_row = storage.create_run(client_id, content_type, format_id, topic=topic, kind=kind, topics=topics)
```

2. The `[AGENT_RUN]` header dict gains `"kind": kind` and uses suggestion-specific stage labels so the terminal shows a sensible single stage:

```python
                "topic": topic,
                "kind": kind,
                "stage_labels": ["Topic Suggestions"] if kind == "suggest" else list(spec.stage_labels),
```

3. The docstring comment for the topic validation block should note it also validates suggest-run hints (the `raw_topic` param carries the hint for `kind="suggest"`). No logic change — same 300-char/no-brace rules.

Pure validator (place directly above `_start_agent_run`):

```python
def _validate_suggestion_selection(
    rows: list[dict], suggestion_ids: list[str], client_id: str, cap: int
) -> tuple[str, str, list[str]]:
    """Validate a shortlist selection; returns (content_type, format,
    ordered_topics) in the user's tick order. 422 on any violation, with a
    message the modal can show verbatim."""
    if not suggestion_ids:
        raise HTTPException(status_code=422, detail="select at least one suggested topic")
    if len(set(suggestion_ids)) != len(suggestion_ids):
        raise HTTPException(status_code=422, detail="duplicate suggestion ids in selection")
    by_id = {str(r["id"]): r for r in rows}
    missing = [i for i in suggestion_ids if i not in by_id]
    if missing:
        raise HTTPException(status_code=422, detail=f"unknown suggestion id(s): {missing}")
    ordered = [by_id[i] for i in suggestion_ids]
    if any(r["client_id"] != client_id for r in ordered):
        raise HTTPException(status_code=422, detail="suggestion belongs to a different client")
    if len({r["format"] for r in ordered}) > 1:
        raise HTTPException(status_code=422, detail="all selected topics must share one format")
    used = [str(r["id"]) for r in ordered if r["status"] != "suggested"]
    if used:
        raise HTTPException(
            status_code=422, detail="some selected topics were already used — refresh the list"
        )
    if len(ordered) > cap:
        raise HTTPException(
            status_code=422, detail=f"this format allows at most {cap} topics per run"
        )
    return ordered[0]["content_type"], ordered[0]["format"], [r["topic"] for r in ordered]


def _generate_from_suggestions(client_id: str, suggestion_ids: list[str]) -> dict:
    """Shared launch path for both generate-from-suggestions surfaces."""
    rows = storage.get_topic_suggestions_by_ids(suggestion_ids)
    fmt = rows[0]["format"] if rows else ""
    spec = storage.resolve_format_spec(fmt) if fmt else None
    cap = registry.max_per_run(spec) if spec else 1
    content_type, format_id, topics = _validate_suggestion_selection(
        rows, suggestion_ids, client_id, cap
    )
    result = _start_agent_run(client_id, content_type, format_id, None, kind="generate", topics=topics)
    storage.set_suggestions_status(suggestion_ids, "selected", generate_run_id=result["run_id"])
    return result
```

Admin routes (place after the existing `/run-agent` route, app.py:1003-1006):

```python
@api.post("/suggest-topics")
def suggest_topics(body: SuggestTopicsRequest):
    """Start a discovery-only suggestion round (run kind: suggest)."""
    return _start_agent_run(body.client_id, body.content_type, body.format, body.hint, kind="suggest")


@api.get("/topic-suggestions")
def topic_suggestions(client_id: str = Query(...), format: str = Query(...)):
    """Available (status=suggested) topics for the client+format, newest first."""
    return jsonable(storage.list_topic_suggestions(client_id, format))


@api.post("/generate-from-suggestions")
def generate_from_suggestions(body: GenerateFromSuggestionsRequest):
    return _generate_from_suggestions(body.client_id, body.suggestion_ids)
```

Portal twins (place after the existing `@portal.post("/run-agent")` route):

```python
@portal.post("/suggest-topics")
def portal_suggest_topics(
    body: PortalSuggestTopicsRequest,
    user: dict = Depends(require_client),
    client_id: str | None = Query(default=None),
):
    cid = _portal_cid(user, client_id)
    return _start_agent_run(cid, body.content_type, body.format, body.hint, kind="suggest")


@portal.get("/topic-suggestions")
def portal_topic_suggestions(
    format: str = Query(...),
    user: dict = Depends(require_client),
    client_id: str | None = Query(default=None),
):
    return jsonable(storage.list_topic_suggestions(_portal_cid(user, client_id), format))


@portal.post("/generate-from-suggestions")
def portal_generate_from_suggestions(
    body: PortalGenerateFromSuggestionsRequest,
    user: dict = Depends(require_client),
    client_id: str | None = Query(default=None),
):
    return _generate_from_suggestions(_portal_cid(user, client_id), body.suggestion_ids)
```

- [ ] **Step 4: Run the full suite**

Run: `uv run pytest tests/ -v`
Expected: all PASS

- [ ] **Step 5: Commit**

```powershell
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py tests/test_topic_suggestions.py
git commit -m @'
feat(api): suggest-topics, topic-suggestions and generate-from-suggestions (admin + portal)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 7: Frontend — suggestion panel + three-mode modals

**Files:**
- Create: `frontend/src/components/TopicSuggestPanel.tsx`
- Modify: `frontend/src/components/RunAgentModal.tsx`
- Modify: `frontend/src/components/PortalRunModal.tsx`

**Interfaces:**
- Consumes: `apiFetch` from `@/lib/api` (portal paths automatically carry `?client_id=`); the `max_per_run` field on each format from Task 2; backend routes from Task 6.
- Produces: `<TopicSuggestPanel clientId contentType formatId maxPerRun endpoints onStarted />` where `endpoints = { suggest, list, generate }` are path strings; `clientId` is a string for admin, `null` for portal (JWT-scoped).

- [ ] **Step 1: Create `TopicSuggestPanel.tsx`**

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type SuggestEndpoints = {
  suggest: string; // POST: start a suggestion round
  list: string; // GET: available suggestions (format=... appended here)
  generate: string; // POST: generate from selected suggestion ids
};

/** Suggest-me-topics mode: list existing suggestions for the format, start a
 *  new round (optional taste hint), tick up to maxPerRun topics, generate.
 *  Admin passes clientId; the portal passes null (the JWT scopes it). */
export default function TopicSuggestPanel({
  clientId,
  contentType,
  formatId,
  maxPerRun,
  endpoints,
  onStarted,
}: {
  clientId: string | null;
  contentType: string;
  formatId: string;
  maxPerRun: number;
  endpoints: SuggestEndpoints;
  onStarted: () => void; // close modal + open the run terminal
}) {
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sep = endpoints.list.includes("?") ? "&" : "?";
      const res = await apiFetch(`${endpoints.list}${sep}format=${encodeURIComponent(formatId)}`);
      const data = await res.json().catch(() => []);
      setSuggestions(Array.isArray(data) ? data : []);
    } catch {
      setSuggestions([]);
    }
    setLoading(false);
  }, [endpoints.list, formatId]);

  useEffect(() => {
    setSelected([]);
    load();
  }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (maxPerRun === 1) return [id]; // single-piece formats behave like radios
      if (prev.length >= maxPerRun) return prev; // cap reached: ignore the tick
      return [...prev, id];
    });
  };

  const post = async (path: string, body: any) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok || res.status === 409) {
        onStarted();
        return;
      }
      setError(String(data.detail || data.error || `Request failed (${res.status})`));
      if (res.status === 422) load(); // stale selection: refresh the list
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    }
    setSubmitting(false);
  };

  const startSuggest = () =>
    post(endpoints.suggest, {
      ...(clientId ? { client_id: clientId } : {}),
      content_type: contentType,
      format: formatId,
      hint: hint.trim() || null,
    });

  const startGenerate = () =>
    post(endpoints.generate, {
      ...(clientId ? { client_id: clientId } : {}),
      suggestion_ids: selected,
    });

  const inputClass =
    "w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5 outline-none transition-colors";

  return (
    <div className="space-y-3">
      <div>
        <textarea
          className={inputClass + " resize-none"}
          rows={2}
          maxLength={300}
          placeholder="What kind of topics do you have in mind? (optional)"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
        />
        <button
          onClick={startSuggest}
          disabled={submitting}
          className="mt-2 w-full px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 text-sm font-semibold rounded-lg border border-gray-700 transition-colors"
        >
          {suggestions.length > 0 ? "✦ Generate more topics" : "✦ Suggest topics"}
          <span className="text-gray-500 font-normal"> (~2–4 min)</span>
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading suggestions…</p>
      ) : suggestions.length === 0 ? (
        <p className="text-sm text-gray-500">
          No suggestions yet for this format — click “Suggest topics” to get 10 researched ideas.
        </p>
      ) : (
        <>
          <p className="text-xs text-gray-400 uppercase tracking-wider">
            {maxPerRun === 1 ? "Pick 1 topic" : `Pick up to ${maxPerRun} topics`}
            <span className="float-right font-mono normal-case">
              {selected.length} / {maxPerRun} selected
            </span>
          </p>
          <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
            {suggestions.map((s) => {
              const id = String(s.id);
              const checked = selected.includes(id);
              return (
                <label
                  key={id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    checked ? "border-blue-500 bg-blue-500/10" : "border-gray-800 bg-gray-900 hover:border-gray-700"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(id)}
                    className="accent-blue-500 mt-1"
                  />
                  <span>
                    <span className="block text-sm text-gray-200">{s.topic}</span>
                    <span className="block text-xs text-gray-500 mt-1">
                      {s.pillar}
                      {s.rationale ? ` — ${s.rationale}` : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <button
            onClick={startGenerate}
            disabled={submitting || selected.length === 0}
            className="w-full px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-lg shadow-blue-500/20 transition-all border border-blue-400/20 active:scale-95"
          >
            {submitting ? "Starting…" : `▶ Generate content (${selected.length})`}
          </button>
        </>
      )}

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-900/50 rounded-lg text-red-400 text-sm">{error}</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Rework `RunAgentModal.tsx` to three modes**

Changes (keep everything else — client/content-type/format selectors, handleRun, styling — as is):

1. Import the panel: `import TopicSuggestPanel from "@/components/TopicSuggestPanel";`
2. Mode state becomes three-valued:

```tsx
const [topicMode, setTopicMode] = useState<"discover" | "suggest" | "user">("discover");
```

3. Compute the selected format's cap next to `typeFormats`:

```tsx
const currentFormat = typeFormats.find((f: any) => f.id === formatId);
const maxPerRun = Number(currentFormat?.max_per_run ?? 1);
```

4. Replace the Topic Source radio group with three radios (same markup pattern; `name="topic-mode"`):
   - `Discover automatically & generate` → sets `"discover"` (RENAMED label)
   - `Suggest me topics` → sets `"suggest"`
   - `I have a topic` → sets `"user"` (unchanged)
5. Below the radios render the panel in suggest mode:

```tsx
{topicMode === "suggest" && (
  <TopicSuggestPanel
    clientId={clientId}
    contentType={contentType}
    formatId={formatId}
    maxPerRun={maxPerRun}
    endpoints={{
      suggest: "/api/suggest-topics",
      list: `/api/topic-suggestions?client_id=${encodeURIComponent(clientId)}`,
      generate: "/api/generate-from-suggestions",
    }}
    onStarted={() => {
      onClose();
      onStarted();
    }}
  />
)}
```

6. Hide the footer's `▶ Run Agent` button in suggest mode (the panel owns its buttons): wrap the existing run button in `{topicMode !== "suggest" && (...)}`. The Cancel button stays always visible.

- [ ] **Step 3: Rework `PortalRunModal.tsx` the same way**

Identical changes with the portal specifics:
- `clientId={null}` (JWT-scoped; `apiFetch` appends `?client_id=` automatically for multi-client logins),
- endpoints:

```tsx
endpoints={{
  suggest: "/api/portal/suggest-topics",
  list: "/api/portal/topic-suggestions",
  generate: "/api/portal/generate-from-suggestions",
}}
```

- radio group name stays `"portal-topic-mode"`; the `Discover automatically` label also becomes `Discover automatically & generate`; the footer `▶ Generate` button hidden in suggest mode.

- [ ] **Step 4: Type-check the frontend**

Run: `cd frontend; npx tsc --noEmit`
Expected: exit 0 (no new type errors).

- [ ] **Step 5: Commit**

```powershell
git add frontend/src/components/TopicSuggestPanel.tsx frontend/src/components/RunAgentModal.tsx frontend/src/components/PortalRunModal.tsx
git commit -m @'
feat(frontend): Suggest me topics mode with shortlist caps in both run modals

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
'@
```

---

### Task 8: Live E2E on Frugaa

**Files:**
- No repo changes (verification only; use the scratchpad for the helper script).

**Interfaces:**
- Consumes: everything above; the local backend on :8000 (restart it so the new code loads — the currently running process predates these changes); admin JWT minted from `.env`'s `SUPABASE_JWT_SECRET` (HS256, `aud: authenticated`, `app_metadata: {"role": "admin"}` — the session scratchpad already has `frugaa_admin.py` with this pattern).

- [ ] **Step 1: Restart the local backend with the new code**

Stop whatever holds :8000, then:

```powershell
uv run uvicorn casinogurus_ai_content_engine___daily_5_topic_batch.app:app --host 127.0.0.1 --port 8000
```

(run in background). Verify `GET /healthz` returns `{"status":"ok"}` and `GET /api/formats` rows now include `max_per_run` (1 for blog, 5 for linkedin_post).

- [ ] **Step 2: Suggestion round with a taste hint**

`POST /api/suggest-topics` with `{"client_id": "frugaa", "content_type": "short_form", "format": "linkedin_post", "hint": "gift guide topics"}` → expect `{"status": "started", "run_id": ...}`. Poll `GET /api/runs?client_id=frugaa` until that run is `succeeded` (~2-4 min).
Then `GET /api/topic-suggestions?client_id=frugaa&format=linkedin_post` → expect ~10 rows, each with `topic`, `pillar`, `rationale`, `status: "suggested"`, `hint: "gift guide topics"`, and gift-leaning topics.

- [ ] **Step 3: Generate 2 posts from the shortlist**

Pick 2 suggestion ids from Step 2. `POST /api/generate-from-suggestions` with `{"client_id": "frugaa", "suggestion_ids": [id1, id2]}` → `started`. Immediately re-fetch the suggestion list: the two rows must be gone from it (`status: "selected"`). Poll the run to `succeeded`, note its `batch_id`.

- [ ] **Step 4: Verify the batch and the status flips**

`GET /api/batches/{batch_id}` → exactly 2 packages whose `topic` values equal the two selected suggestion topics verbatim. Then confirm both suggestion rows are `status: "generated"` (query via a one-off script or a temporary `GET /api/topic-suggestions?...` check with status param defaulting to suggested — absence from the list plus a direct DB/SQL check through the helper script is fine).

- [ ] **Step 5: Negative checks**

- `POST /api/generate-from-suggestions` re-using one already-generated id → 422 "already used".
- `POST /api/generate-from-suggestions` with 6 linkedin ids (run one more suggest round if needed) → 422 "at most 5 topics per run".
- `POST /api/suggest-topics` with `hint: "bad {token} hint"` → 422 (brace-token rule).

- [ ] **Step 6: Report results**

No commit (nothing changed). Summarize run ids, timings, the suggested topics, and the generated post topics for the user; flag any deviation.

---

## Self-Review Notes (already applied)

- Spec coverage: data model (Task 1), API + caps (Tasks 2, 6), suggest crew + avoid-list + JSON contract (Tasks 4, 5), multi-topic generation incl. per-topic research wording (Tasks 3, 4, 5), modal UX + rename (Task 7), error handling (422s Task 6, parse-failure Task 5, revert-on-failure Task 5), tests (Tasks 2-6) + live E2E (Task 8). Suggestions expose `rationale` per spec; `hint` is persisted per row via `run_row["topic"]` in `save_topic_suggestions`.
- Blog-from-shortlist pins `topics[0]` through the existing `{topic_directive}` path (Task 5) — spec's "identical to the enter-your-own-topic path".
- Portal scoping: every portal twin resolves the client via `_portal_cid` and never trusts the body (Task 6); `_generate_from_suggestions` re-checks row ownership against the resolved client in `_validate_suggestion_selection`.
- Type consistency: `_start_agent_run(..., kind, topics)` (Task 6) matches `create_run(..., kind, topics)` (Task 1); `suggestion_directive` produced in Task 3 and consumed by name in Task 5; `max_per_run` produced in Task 2, consumed in Tasks 6 and 7; `TopicSuggestionBatch` produced in Task 4, consumed in Tasks 4 (crew) and 5 (tests/parser).
