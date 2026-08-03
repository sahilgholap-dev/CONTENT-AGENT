# Autopilot: overnight scheduled drafting per business

**Date:** 2026-08-03
**Status:** Approved by Sahil (design discussion in session)

## Problem

Clients want a content rhythm without clicking Create every day: pick
frequencies per content type, see next week's planned topics in advance,
veto anything, and wake up to drafts. Nothing may disturb manual drafting.

## Decisions (made with user)

1. **Overnight window.** All autopilot generation becomes eligible at
   **12:00 AM local time per business** and drains through the night
   (~55–75 run capacity vs ~2–3 needed per loaded client). Veto deadline is
   "before midnight" of the item's night.
2. **Per-business everything.** Config, queue, pause, and timezone are keyed
   by `client_id`. The Autopilot page shows the workspace selected in the
   sidebar. Timezone column default `Asia/Kolkata`.
3. **Humans always win.** The executor only launches when the engine is
   idle; manual Creates jump ahead of every waiting autopilot item; an
   in-flight run is never cancelled. The Create wizard shows a polite
   auto-start waiting state if it ever collides with an in-flight run.
4. **Fairness across clients:** oldest-eligible-first across all businesses.
5. **Guardrail:** skip a client's generation while they have ≥10 unreviewed
   autopilot drafts (note recorded on the queue item).
6. **Missed slots:** run late within 24h of eligibility; after that mark
   `missed`, never double-generate. Failed runs mark `failed` (no auto-retry).
7. **Reuse over new machinery:** planned topics come from the existing
   `topic_suggestions` pool (pool refills via `kind='suggest'` runs);
   generation is the existing pinned-single-topic run → exactly one piece →
   Drafts with an ⟳ Autopilot badge.
8. **Weekly caps** (slider max client-side, 400 server-side): blog 2,
   linkedin_post 5, youtube_long 4, youtube_short 4. One piece per format
   per night (frequency N/week = N distinct nights).

## Data model (additive, idempotent)

```sql
CREATE TABLE IF NOT EXISTS autopilot_config (
    client_id     TEXT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
    paused        BOOLEAN NOT NULL DEFAULT false,
    timezone      TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    content_types JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- content_types: {"blog": {"enabled": bool, "frequency_per_week": 0..cap}, ...}
-- keyed by FORMAT id (blog, linkedin_post, youtube_long, youtube_short)

CREATE TABLE IF NOT EXISTS autopilot_queue (
    id              UUID PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    content_type    TEXT NOT NULL,
    format          TEXT NOT NULL,
    suggestion_id   UUID,
    topic           TEXT NOT NULL,
    night_of        DATE NOT NULL,             -- local date whose midnight unlocks it
    eligible_from   TIMESTAMPTZ NOT NULL,      -- that midnight in UTC
    veto_expires_at TIMESTAMPTZ NOT NULL,      -- same instant
    state           TEXT NOT NULL DEFAULT 'pending',
    -- pending | approved | skipped | generating | done | failed | missed
    swap_count      INTEGER NOT NULL DEFAULT 0, -- max 1 (brief)
    generate_run_id UUID,
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, format, night_of)
);

ALTER TABLE runs ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual';
-- 'manual' | 'autopilot' — powers the Drafts badge/filter
```

## Scheduler (in-process loop, no new infra)

`autopilot.py`, started from the FastAPI lifespan as an asyncio task ticking
~60s (`AUTOPILOT_DISABLED=1` env kill-switch for local/test). Each tick, all
DB-driven, so restarts resume cleanly:

1. **Plan** (per non-paused client, per enabled format): ensure queue rows
   exist for the next 7 local nights — `frequency_per_week` distinct
   weekday nights (1→Mon; 2→Mon/Thu; 3→Mon/Wed/Fri; 4→Mon/Tue/Thu/Fri;
   5→Mon–Fri), topics drawn oldest-first from unused `topic_suggestions`
   (not referenced by an active queue row). Pool short → flag a refill.
2. **Execute** (only when the engine is idle — humans always first):
   a. one flagged refill → launch a `kind='suggest'` run (origin autopilot);
   b. else oldest eligible queue item across clients with
      `state in (pending, approved)` and `eligible_from <= now`:
      >24h past eligibility → `missed`; guardrail breach → note + skip
      client; else launch the pinned-topic generate run
      (`topics=[topic]`, `origin='autopilot'`), mark `generating`,
      mark its suggestion `selected`.
3. **Reap**: `generating` items whose run finished → `done` / `failed`.

Veto actions (until midnight): **Approve** (state approved), **Skip**
(skipped; suggestion returns to pool), **Swap** (replace topic with next
unused suggestion; swap_count 0→1; once only). Past midnight, pending items
are treated as approved (brief behaviour).

## API (admin + portal twins, standard client scoping)

- `GET  /autopilot/config` → `{paused, timezone, content_types}` (+caps)
- `PUT  /autopilot/config` → validate caps (400 over-cap), timezone (zoneinfo)
- `POST /autopilot/pause` / `POST /autopilot/resume`
- `GET  /autopilot/queue` → upcoming items (topic, night, veto deadline, state)
- `POST /autopilot/queue/{id}/approve` / `swap` / `skip` (422 after deadline
  or swap limit)

`GET /api/portal/pieces` gains `origin` (join batches.run_id → runs.origin).

## Frontend

- Sidebar: **Autopilot** nav item + indicator ("Autopilot: on/paused",
  green pulse) fed by the config endpoint for the selected workspace.
- `/portal/autopilot`: pause banner; one card per content type (toggle,
  slider capped, "generates overnight — ready by your morning", next night);
  queue rows with Approve / Swap / Skip + veto countdown.
- Drafts: ⟳ Autopilot badge (origin) + working Autopilot filter chip.
- Create wizard: on 409/busy, waiting state that auto-starts when idle.

## Build order

1. Schema + storage helpers + caps/night-spread pure functions (+tests).
2. Config endpoints ×2 surfaces + pause/resume (+tests for cap validation).
3. Planner + queue endpoints + veto actions (+tests, incl. timezone math).
4. Scheduler loop (refill, executor with fairness/guardrail/missed, reaper),
   `runs.origin`, pieces `origin`.
5. Autopilot page, sidebar item + indicator, Drafts badge/chip, wizard wait.
6. Live E2E: two clients, short-window test config — isolation, fairness,
   manual priority, badges. Handoff.

## Out of scope (later)

Concurrent generation workers ("second chef"), per-client custom hours,
retry policies, notification emails, admin autopilot overview dashboard.
