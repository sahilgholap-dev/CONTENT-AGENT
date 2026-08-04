# Concurrent Runs (Worker Pool) — Design

**Date:** 2026-08-04
**Status:** Approved
**Prior art:** `2026-08-03-autopilot-design.md` (scheduler this builds on)

## Problem

The engine runs at most one crew subprocess at a time. A single `_run_state`
slot in `app.py` 409s any second launch, every run overwrites the one shared
`agent.log`, and the autopilot scheduler launches at most one item per 60s
tick, only when the engine is idle. With multiple clients enabled, one
client's draft blocks every other client's work — sometimes for the length of
a full pipeline run.

**Goal:** no client's content ever waits because another client's content is
being drafted. Parallel across clients; still serial within a client.

## Decisions (from brainstorm)

- **Approach:** in-process worker pool (Approach A). Celery/external workers
  were considered and rejected for now: they add Redis + a second Railway
  service + a log-transport rewrite + distributed locks, and solve a
  scale-beyond-one-machine problem we do not have. The launch path stays
  behind the existing `launch_*` seam so a queue-backed implementation can
  drop in later.
- **Pool size:** `MAX_CONCURRENT_RUNS` env var, default 3.
- **Per-client rule:** at most one active run per client, ever. Parallelism
  is across clients only (protects the client's topic pool from
  refill/consume races and keeps per-client progress unambiguous).
- **Humans first:** autopilot may fill at most `MAX_CONCURRENT_RUNS - 1`
  slots, so one slot is always free for a manual run. When the pool size is
  1, autopilot may use that slot only when it is idle (today's behavior).

## Design

### 1. Run registry + per-run logs

Replace the single `_run_state` slot with a registry:

```python
_runs: dict[str, dict] = {}   # run_id -> {process, log_file, client_id, origin, started_at}
_runs_lock = threading.Lock()
```

- Every mutation and read of `_runs` holds `_runs_lock`.
- Each run writes to its own log file: `logs/run-<run_id>.log` under the
  project root (`logs/` is gitignored). The `[AGENT_RUN]` JSON header stays
  as line 1 — SSE and progress parsing keep working per file.
- `_reap_registry()` drops entries whose process has exited and closes their
  log file handles. It runs at the top of every launch attempt and every
  scheduler tick. (Run *status* reaping stays where it is: the subprocess
  updates its own `runs` row, and `autopilot.tick` settles queue items from
  the DB as today.)

### 2. Launch gate

`_start_agent_run` starts a run only if, under the lock, both hold:

1. the target client has no entry in `_runs` with a live process, and
2. `len(live entries) < MAX_CONCURRENT_RUNS`.

Otherwise it raises 409 (same status code as today, so the Create wizard's
existing auto-retry loop keeps working; only the detail text changes —
"client already has a run in progress" vs "engine at capacity").

Check-then-register happens inside one lock hold so two simultaneous
requests cannot both pass the gate.

### 3. Autopilot scheduler

`autopilot.tick(engine_idle, ...)` becomes `autopilot.tick(capacity, ...)`
where `capacity()` returns a snapshot computed from the registry:

```python
{"free": int,              # MAX - live runs
 "autopilot_budget": int,  # slots autopilot may still claim this tick
 "busy_clients": set[str]} # clients with a live run
```

`autopilot_budget = max(0, (MAX - 1 if MAX > 1 else MAX) - live autopilot-origin runs)`,
further capped by `free`.

Tick behavior changes from "launch at most one" to "launch up to budget":

- Reap/settle and plan phases: unchanged.
- Launch phase: iterate refills first, then `due_queue_items()` oldest-first
  (existing cross-client fairness), skipping any item whose client is in
  `busy_clients` or already received a launch this tick. Stop when the
  budget is exhausted. Missed/guardrail handling per item is unchanged.
- Return value: a comma-joined action string (e.g.
  `"refill:frugaa:blog,generate:<id>"`), `"idle"`, or `"busy"` (budget 0).

### 4. Log and progress surfaces

- **Portal progress** (`GET /portal/run-progress`): resolve the caller's
  client to its (single possible) live run via the registry, parse that
  run's log file. No live run → the same empty shape as today.
- **Admin terminal** (`GET /api/agent-logs` SSE): optional `?run_id=` query
  param selects a specific run's log. Without it, tail the most recently
  started live run (matches current single-run behavior). The stream closes
  when that run's process exits. Admin UI unchanged; a run picker is future
  scope.

### 5. Restart handling + housekeeping

- **Startup orphan sweep:** in lifespan startup, mark any `runs` rows still
  in a non-terminal status as `failed` with `error="server restarted"`.
  (Fixes a latent single-run bug too: a deploy mid-run currently leaves the
  row `running` forever.) Autopilot's normal reap then settles the affected
  queue items and the night re-plans.
- **Log cleanup:** on each launch, delete `logs/run-*.log` older than 14
  days.

### What deliberately does not change

- API request/response shapes and portal/admin UI (no frontend work needed).
- Subprocess-per-run execution model (`python -m <pkg>.main run --run-id`).
- Autopilot planner, queue semantics, guardrails, and topic-source flows.
- Manual-run UX: full pool still answers 409; the wizard already retries.

## Error handling

- Spawn failure: unchanged (run row marked failed) — now also removes the
  registry entry.
- Process exit without status update (crash): row stays `running` until the
  orphan sweep on next boot, or `autopilot.tick`'s reap sees the run row
  terminal. Additionally, `_reap_registry()` marks a run row `failed` if its
  process exited but the row is still non-terminal after a grace period
  (30s) — covers crashes without waiting for a restart.
- Registry/DB disagreement resolves in favor of the DB for queue-item
  settlement (as today) and in favor of the registry for slot accounting.

## Testing

- Update existing tick tests: fake `capacity()` instead of `engine_idle`;
  assert multi-launch up to budget, per-client skip, budget exhaustion.
- New unit tests:
  - launch gate: per-client 409, capacity 409, both checks under lock;
  - autopilot budget: MAX=1 idle-only behavior, MAX=3 → 2-slot budget,
    in-flight autopilot runs reduce budget;
  - orphan sweep marks non-terminal rows failed;
  - progress endpoint resolves the caller's run log among several live logs;
  - log cleanup deletes only old `run-*.log` files.
- Existing 53 tests must keep passing; `tsc`/`next build` untouched.
- Live smoke: enable autopilot for 2+ clients with force-eligible items,
  verify both generate simultaneously (two live `run-*.log` files, two
  `generating` queue items), verify a manual run still gets the reserved
  slot, and verify per-client progress endpoints report distinct runs.

## Out of scope (future)

- Queue-backed durable launches (Celery / Postgres SKIP LOCKED) — seam kept.
- Admin UI run picker for the live terminal.
- Per-provider LLM rate-limit throttling across concurrent runs.
- Multiple API replicas (registry is per-process; deployment stays at 1).
