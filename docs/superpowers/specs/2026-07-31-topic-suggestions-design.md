# Topic suggestions: suggest → shortlist → generate

**Date:** 2026-07-31
**Status:** Approved by Sahil (design review in session)

## Problem

Both run modals offer only "Discover automatically" (agent picks one topic and
generates content end-to-end) or "Enter your topic" (user types one topic).
There is no way to see topic options before committing an expensive full
generation run, steer the agent toward a different kind of topic, or pick
several topics for a multi-post format. For multi-post formats the agent
always produces N angle-posts of one theme; the user cannot choose the
individual post topics.

## Decisions (made with user)

1. **Selection semantics:** suggestions are individual content topics. The
   user ticks up to the format's per-run limit (blog: exactly 1; LinkedIn /
   Instagram / Facebook / video: up to 5) and the generate run produces one
   piece of content per ticked topic (3 ticked → 3 posts). This replaces the
   theme→angles behavior *only* for runs launched from a shortlist; automatic
   runs keep today's behavior.
2. **Suggestion engine:** the real discovery agent with web research (a full
   CrewAI task, ~2–4 min per round), not a fast ungrounded LLM call.
3. **Surfaces:** both the admin Run Agent modal and the portal Generate modal.
4. **Rename:** existing automatic mode becomes **"Discover automatically &
   generate"**; new mode is **"Suggest me topics"**; "Enter your own topic"
   stays.
5. **Round size / retention:** each round proposes 10 topics; rounds
   accumulate (older unpicked suggestions stay listed); each new round is told
   to avoid all previously suggested and recently published topics. No
   dismiss/delete in v1.
6. **Architecture (Approach A):** suggest runs reuse the existing run
   machinery — same `runs` table, one-run-at-a-time lock, subprocess kickoff,
   SSE log terminal, profile-version pinning — with a discovery-only crew
   variant. Rejected: inline API call (no progress/history, blocks a worker,
   bypasses the run lock); cross-format planning board (scope, and topic style
   differs per format).

## Design

### 1. Data model

`runs` table, two new columns:

- `kind text NOT NULL DEFAULT 'generate'` — `'generate' | 'suggest'`.
- `topics jsonb` — list of pinned topic strings for generate runs launched
  from a shortlist. The existing `topic` column is unchanged for the
  enter-your-own-topic mode; for `kind='suggest'` runs it stores the optional
  taste hint (documented in schema.sql), reusing its existing ≤300-char /
  no-brace-token validation.

New `topic_suggestions` table:

| column | type | notes |
| --- | --- | --- |
| id | uuid pk | |
| client_id | text fk clients | |
| content_type | text | e.g. `short_form` |
| format | text | e.g. `linkedin_post` |
| topic | text | the suggested topic/title |
| pillar | text | from the client's pillar taxonomy |
| primary_keyword | text | |
| search_intent | text | informational / commercial / transactional |
| rationale | text | one-sentence "why this deserves to exist" |
| hint | text nullable | taste hint of the round that produced it |
| suggest_run_id | uuid fk runs | round provenance |
| status | text | `suggested` → `selected` → `generated` |
| generate_run_id | uuid nullable fk runs | set when selected |
| created_at | timestamptz | |

Status flow: rows insert as `suggested`; `generate-from-suggestions` flips the
chosen rows to `selected` and stamps `generate_run_id`; when that run
succeeds, its linked rows flip to `generated`. If the run fails, rows revert
to `suggested` so they can be retried.

### 2. API

Three endpoints, each with an admin and a portal twin. Portal twins resolve
`client_id` from the JWT via the existing `resolve_portal_scope`; admin twins
take `client_id` explicitly.

1. `POST /api/suggest-topics` (portal: `POST /api/portal/suggest-topics`)
   Body: `{client_id, content_type, format, hint?}` (portal: no client_id in
   body; `?client_id=` query param as with other portal calls).
   Creates a `kind='suggest'` run through the shared `_start_agent_run` path:
   same format/client validation, same 409 when a run is already going.
   `hint` is optional, ≤300 chars, no `{token}` shapes (422 otherwise).

2. `GET /api/topic-suggestions?client_id=&format=` (portal twin scoped)
   Returns rows with `status='suggested'` for the client+format, newest
   first, capped at 50.

3. `POST /api/generate-from-suggestions` (portal twin scoped)
   Body: `{suggestion_ids: [uuid, ...]}` (admin also `client_id`).
   Validation (422 with a human message on failure): all ids exist, belong to
   the client, share one format, all `status='suggested'`, and
   `1 ≤ count ≤ max_per_run` for that format. Creates a `kind='generate'`
   run with `topics=[...]` pinned, marks rows `selected`.

`GET /api/formats` additionally exposes `max_per_run` per format (1 for blog;
`posts_per_batch`/`scripts_per_batch` — currently 5 — for social/video) so
the UI never hardcodes limits.

### 3. Suggest crew variant

- New `tasks_suggest.yaml` with one task, executed by the existing discovery
  agent (client-flavored via `discovery_role/goal/backstory`, same web-search
  tools). Prompt = the same voice + client-directives + discovery-playbook
  context as production discovery, plus a `{suggestion_directive}` block:
  propose exactly 10 distinct topics for this format; honor the taste hint if
  present; avoid the supplied list of prior suggestions and recent package
  topics; output a strict JSON array of
  `{topic, pillar, primary_keyword, search_intent, rationale}`.
- `CREW_BY_VARIANT` gains a `suggest` entry: discovery agent + this single
  task. No drafter/compliance/SEO stages.
- `main.py` branches on `run.kind`: suggest runs dump raw output first (the
  existing `_dump_raw_output` safety net), parse the JSON array, insert
  `topic_suggestions` rows, and mark the run succeeded — no batch, no images.
  A parse failure marks the run failed with the error; the raw dump preserves
  the round.
- The avoid-list (last 50 suggestion topics for the client+format + the
  client's last 100 package topics) is queried from storage at kickoff in
  `main._resolve_run` and injected as an input.
- All new YAML placeholders get safe defaults in `build_inputs` so
  `audit_yaml_placeholders` (which scans every `tasks*.yaml` with one input
  set) keeps passing for normal runs.

### 4. Multi-topic generation

- `_topic_directive` gains list rendering: with `topics=[...]` pinned the
  directive instructs "structure exactly these N topics, one piece of content
  per topic, in the given order; do not invent additional topics".
- Social/video task prompts already parameterize output count as
  `{posts_per_batch}` / `{scripts_per_batch}`; when topics are pinned that
  input becomes `len(topics)`. Selecting 3 LinkedIn topics yields exactly 3
  posts.
- The social/video research task prompt is adjusted so that when topics are
  pinned it grounds each pinned topic individually instead of one shared
  theme (conditional wording inside the same task via the directive input).
- Blog runs from a shortlist pin a single topic — identical to the existing
  enter-your-own-topic path.

### 5. Frontend

Both `RunAgentModal` (admin) and `PortalRunModal` (portal):

- Mode radio becomes: **Discover automatically & generate** (renamed) /
  **Suggest me topics** (new) / **Enter your own topic** (unchanged).
- Suggest mode panel:
  - On open, fetch available suggestions for the selected format and render
    as a checkbox list (topic, pillar, rationale); newest round on top.
  - "Suggest topics" button (labeled "Generate more topics" once suggestions
    exist) with an optional text box — *"What kind of topics do you have in
    mind? (optional)"* — kicks off a suggest run; the modal switches to the
    existing live log terminal; on completion the list refreshes.
  - Selection is capped by the format's `max_per_run`: blog renders as a
    single-select; multi-post formats show "N / 5 selected" and block ticks
    past the cap.
  - "Generate content (N)" calls `generate-from-suggestions` and hands off to
    the existing run progress → batch → review flow.
- `lib/api.ts` gains the three call pairs (admin + portal, portal ones
  carrying `?client_id=` like existing portal calls).

### 6. Error handling

- Suggest-run JSON parse failure → run `failed`, error in the SSE terminal
  and run history; raw output dumped server-side for manual re-ingest.
- Concurrent run → existing 409 surface ("Agent is already running").
- Stale selections (used meanwhile / over cap / mixed formats / wrong
  client) → 422 with a clear message; the UI refreshes the list.
- Generate-run failure reverts its suggestions to `suggested` (retryable).
- Suggestions reference topics as plain text; profile updates between rounds
  don't invalidate them.

### 7. Testing

- Unit (pytest, `tests/`): selection validation (cap, mixed formats,
  already-used, wrong client), `_topic_directive` list rendering +
  `posts_per_batch` override, suggestion JSON parsing/persistence including
  malformed output, `max_per_run` exposure in the formats payload.
- Live E2E on Frugaa: one suggest round with hint "gift guide topics";
  verify 10 rows land and the terminal streams; pick 2 LinkedIn topics;
  verify exactly 2 posts generate with those exact topics and the rows flip
  `suggested → selected → generated`.

## Out of scope (v1)

- Dismiss/delete for suggestions (unpicked rows just age down the list).
- Cross-format planning board / run queueing.
- Scheduling suggestion rounds automatically.
