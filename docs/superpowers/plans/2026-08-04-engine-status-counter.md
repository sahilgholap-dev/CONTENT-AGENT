# Engine Occupancy Counter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Create wizard's "engine busy" waiting banner shows live anonymous occupancy ("All 3 writing slots are busy (2 autopilot, 1 manual) — yours starts automatically when one frees.").

**Architecture:** `RunPool` gains a lock-guarded `occupancy()` counts query; a new client-authenticated `GET /api/portal/engine-status` endpoint returns it verbatim; the Create wizard polls that endpoint every 10s while its existing `waitingRun` state is set and renders the counts in the banner, falling back to today's generic text. The 30s auto-retry loop that actually starts runs is untouched. Spec: `docs/superpowers/specs/2026-08-04-engine-status-counter-design.md`.

**Tech Stack:** Python 3 / FastAPI backend, Next.js (App Router, TypeScript) frontend. No new dependencies.

## Global Constraints

- Response shape (exact keys): `{"busy": int, "max": int, "autopilot": int, "manual": int}`. Counts only — no client ids, no run ids, identical answer for every caller.
- Reservations count as busy; exited (lingering) entries do not.
- Endpoint requires client auth (`Depends(require_client)`) like every other portal endpoint.
- Frontend: status poll is display-only — any fetch failure keeps the generic banner and must never affect the 30s retry loop.
- Banner copy (exact strings, from the spec): full → `All {max} writing slots are busy{detail} — yours starts automatically when one frees.`; partial → `{busy} of {max} writing slots busy{detail} — starting yours shortly.`; no data or busy=0 → today's generic sentence. `{detail}` = ` (2 autopilot, 1 manual)` with zero-count fragments omitted.
- Tests run via `.venv\Scripts\python.exe -m pytest tests/` (bare `python` is an unrelated global 3.14). Frontend checks run from `frontend/`: `npx tsc --noEmit` and `npm run build`.
- Frontend note: `frontend/AGENTS.md` warns this Next.js version differs from training data — copy the in-file patterns (`apiFetch`, poll `useEffect`s already in `create/page.tsx`) rather than inventing new ones.
- Windows: use Edit/Write tools, never PowerShell Get/Set-Content. Do NOT push.

---

### Task 1: Backend — `RunPool.occupancy()` + `GET /api/portal/engine-status`

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/runpool.py` (add method after `capacity()`)
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py` (add endpoint directly after `portal_run_progress`)
- Test: `tests/test_runpool.py`

**Interfaces:**
- Consumes: existing `RunPool` internals (`_lock`, `_reap_locked`, `_entries`, `_max`), existing `require_client` dependency and `_pool` instance in app.py.
- Produces: `RunPool.occupancy() -> dict` with keys `busy, max, autopilot, manual` (all ints); `GET /api/portal/engine-status` returning that dict as JSON — Task 2's frontend consumes this exact shape.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_runpool.py` (after the `test_max_slots_env` test):

```python
# ----------------------------- occupancy ------------------------------ #

def test_occupancy_empty_pool(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    assert pool.occupancy() == {"busy": 0, "max": 3, "autopilot": 0, "manual": 0}


def test_occupancy_counts_origins_and_reservations(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    start(pool, "a", origin="autopilot")
    start(pool, "b", origin="manual")
    pool.reserve("c", "manual")  # reservation holds a slot
    assert pool.occupancy() == {"busy": 3, "max": 3, "autopilot": 1, "manual": 2}


def test_occupancy_ignores_exited_runs(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    proc, _ = start(pool, "a", origin="autopilot")
    proc.exit(0)
    assert pool.occupancy() == {"busy": 0, "max": 3, "autopilot": 0, "manual": 0}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv\Scripts\python.exe -m pytest tests/test_runpool.py -v`
Expected: the 3 new tests FAIL with `AttributeError: 'RunPool' object has no attribute 'occupancy'`; the existing 17 pass.

- [ ] **Step 3: Implement `occupancy()`**

In `runpool.py`, directly after the `capacity()` method:

```python
    def occupancy(self) -> dict:
        """Anonymous live-slot counts for user-facing status displays —
        no client ids, no run ids (served by /api/portal/engine-status)."""
        with self._lock:
            self._reap_locked()
            live = [e for e in self._entries.values() if e.live()]
            return {
                "busy": len(live),
                "max": self._max(),
                "autopilot": sum(1 for e in live if e.origin == "autopilot"),
                "manual": sum(1 for e in live if e.origin != "autopilot"),
            }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv\Scripts\python.exe -m pytest tests/test_runpool.py -v`
Expected: all 20 PASS.

- [ ] **Step 5: Add the endpoint**

In `app.py`, directly after the `portal_run_progress` function (keep it with the other portal read surfaces):

```python
@portal.get("/engine-status")
def portal_engine_status(user: dict = Depends(require_client)):
    """Anonymous engine occupancy for the Create wizard's waiting banner.
    Counts only — never which clients are writing. The answer is identical
    for every caller, but it still requires a logged-in client."""
    return _pool.occupancy()
```

Note: `apiFetch` appends `?client_id=` to every `/api/portal` path — this endpoint deliberately ignores it (FastAPI drops unknown query params). Do not add a `client_id` parameter.

- [ ] **Step 6: Compile check + full suite**

Run: `.venv\Scripts\python.exe -c "from casinogurus_ai_content_engine___daily_5_topic_batch import app"`
Expected: clean import.

Run: `.venv\Scripts\python.exe -m pytest tests/ -v`
Expected: 85 passed (82 existing + 3 new).

- [ ] **Step 7: Commit**

```bash
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/runpool.py src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py tests/test_runpool.py
git commit -m "feat(pool): anonymous occupancy counts + portal engine-status endpoint"
```

---

### Task 2: Frontend — live occupancy in the waiting banner

**Files:**
- Modify: `frontend/src/app/portal/create/page.tsx` (three additions: helper function, state + poll effect, banner text)

**Interfaces:**
- Consumes: `GET /api/portal/engine-status` → `{"busy": number, "max": number, "autopilot": number, "manual": number}` (Task 1); existing `apiFetch` from `@/lib/api`; existing `waitingRun` state.
- Produces: nothing downstream — terminal UI change.

- [ ] **Step 1: Add the banner-copy helper**

In `create/page.tsx`, directly after the `phaseOf` function (module scope, before `export default`):

```tsx
/** Waiting-banner copy: live occupancy when we have it, generic otherwise.
 *  Origin fragments render only when nonzero. */
function engineStatusText(
  s: { busy: number; max: number; autopilot: number; manual: number } | null
): string {
  if (!s || s.busy <= 0) {
    return "The engine is finishing another piece — yours will start automatically in a few minutes.";
  }
  const parts = [
    s.autopilot > 0 ? `${s.autopilot} autopilot` : null,
    s.manual > 0 ? `${s.manual} manual` : null,
  ].filter(Boolean);
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  if (s.busy >= s.max) {
    return `All ${s.max} writing slots are busy${detail} — yours starts automatically when one frees.`;
  }
  return `${s.busy} of ${s.max} writing slots busy${detail} — starting yours shortly.`;
}
```

- [ ] **Step 2: Add state + poll effect**

Directly after the `waitingRun` state declaration (`const [waitingRun, setWaitingRun] = ...`), add:

```tsx
  // Anonymous engine occupancy shown in the waiting banner (display-only;
  // the 30s auto-retry below is what actually starts the run).
  const [engineStatus, setEngineStatus] = useState<{
    busy: number;
    max: number;
    autopilot: number;
    manual: number;
  } | null>(null);
```

Directly after the existing auto-retry `useEffect` (the one with `setInterval(() => startRun(waitingRun), 30_000)`), add:

```tsx
  // Live occupancy for the waiting banner (every 10s while waiting).
  useEffect(() => {
    if (!waitingRun) {
      setEngineStatus(null);
      return;
    }
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await apiFetch("/api/portal/engine-status");
        if (!res.ok) return;
        const data = await res.json().catch(() => null);
        if (!cancelled && data && typeof data.busy === "number") setEngineStatus(data);
      } catch {
        /* display-only: keep the generic banner text */
      }
    };
    poll();
    const timer = setInterval(poll, 10_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [waitingRun]);
```

- [ ] **Step 3: Use the live text in the banner**

In the `{waitingRun && (...)}` banner JSX, replace exactly these two lines:

```tsx
            The engine is finishing another piece — yours will start automatically in a few minutes.
            You can keep this page open.
```

with:

```tsx
            {engineStatusText(engineStatus)} You can keep this page open.
```

(Everything else in the banner — spinner span, ✕ button — stays identical.)

- [ ] **Step 4: Type-check and build**

Run (from `frontend/`): `npx tsc --noEmit`
Expected: clean.

Run (from `frontend/`): `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/portal/create/page.tsx
git commit -m "feat(portal): waiting banner shows live engine occupancy"
```

---

### Task 3: Live verification (controller-level; no code changes)

**Files:** none (scratchpad scripts allowed)

**Interfaces:**
- Consumes: the running backend + Tasks 1–2.

- [ ] **Step 1: Restart the backend on the new code**

Stop the :8000 uvicorn process and start it again (same command: `.venv\Scripts\python.exe -m uvicorn casinogurus_ai_content_engine___daily_5_topic_batch.app:app --port 8000` with `MAX_CONCURRENT_RUNS=3`). Expect the normal startup lines.

- [ ] **Step 2: Curl the endpoint with a client token**

Mint a client-role JWT (same approach as prior smokes — see `auth.py` + `.env`), then GET `/api/portal/engine-status`.
Expected (idle engine): `{"busy": 0, "max": 3, "autopilot": 0, "manual": 0}`. Without a token: 401/403.

- [ ] **Step 3: Optional occupancy spot-check**

Start one manual run (any test client, pinned topic), re-GET the endpoint.
Expected: `{"busy": 1, ..., "manual": 1}` while it writes; back to 0 busy after it finishes (or after the 300s linger — note `busy` drops immediately on exit because exited entries aren't live). The banner itself is easiest to eyeball during the user's browser walk — a full two-client jam isn't required for this task.

---

## Self-review notes

- Spec coverage: `occupancy()` (T1), endpoint + auth + anonymous counts (T1), banner poll + copy rules + fallback (T2), tests (T1 steps 1–4, T2 step 4, T3 live). "Does not change" honored: no retry-cadence, suggest-flow, or admin edits.
- Type consistency: the `{busy, max, autopilot, manual}` shape is identical in the pool method, endpoint response, frontend state type, and helper signature.
- The banner's busy=0 case deliberately shows the generic sentence (spec: transient state; next retry lands).
