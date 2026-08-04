# Engine Occupancy Counter — Design

**Date:** 2026-08-04
**Status:** Approved
**Prior art:** `2026-08-04-concurrent-runs-design.md` (the worker pool this reads from)

## Problem

With the worker pool live (3 slots, one reserved for manual runs), a client
whose manual run hits a full engine sees only a generic banner: "The engine
is finishing another piece — yours will start automatically." They can't
tell whether the engine is momentarily busy or fully loaded. Sahil wants a
live counter: how many pieces are being written right now.

## Decisions (from brainstorm)

- **Semantics: occupancy, not queue position.** The banner shows what is
  running now. True "you're #2 in line" needs a server-side waiting list
  that does not exist (waiting clients are stateless 30s retries) — out of
  scope; revisit only if clients actually pile up in practice.
- **Placement: waiting banner only.** The counter appears exactly when a
  client is waiting for a slot in the Create wizard. No always-on badge, no
  admin panel (admin already has the runs list and live terminal).
- **Privacy: anonymous counts only.** Clients never see which other clients
  are writing — just numbers and origin split (autopilot vs manual).

## Design

### 1. Pool: `occupancy()`

`runpool.RunPool` gains one query method (same lock discipline as
`capacity()`):

```python
def occupancy(self) -> dict:
    """Anonymous live-slot counts for user-facing status displays."""
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

Reservations count as busy (they hold slots). No client ids, no run ids.

### 2. API: `GET /api/portal/engine-status`

Portal-scoped endpoint (requires client auth via the existing
`require_client` dependency — the caller must be a logged-in client, but
the response is identical for every caller):

```python
@portal.get("/engine-status")
def portal_engine_status(user: dict = Depends(require_client)):
    """Anonymous engine occupancy for the Create wizard's waiting banner.
    Counts only — never which clients are writing."""
    return _pool.occupancy()
```

Response: `{"busy": 3, "max": 3, "autopilot": 2, "manual": 1}`.

### 3. Frontend: live waiting banner

In `frontend/src/app/portal/create/page.tsx`:

- New state `engineStatus: {busy, max, autopilot, manual} | null`.
- While `waitingRun` is set: fetch `engine-status` immediately and then
  every 10s; clear the interval and the state when waiting ends (run
  started or user cancels).
- Banner text becomes, when status is available:
  - `busy >= max`: "All {max} writing slots are busy ({autopilot} autopilot,
    {manual} manual) — yours starts automatically when one frees."
  - `busy < max` (transient — a slot just freed; the next retry should
    land): "{busy} of {max} writing slots busy — starting yours shortly."
  - Origin fragments render only when nonzero (e.g. "(2 autopilot)" when
    manual is 0), and use singular/plural-free phrasing that reads
    naturally either way.
- Fetch failure or pending first fetch → today's generic text unchanged.
  The 30s auto-retry loop is untouched; the status poll is display-only.

### What deliberately does not change

- The suggest-flow's static 409 error message (that flow errors rather
  than waits — separate concern).
- Retry cadence, pool semantics, 409 payloads, admin surfaces.

## Error handling

- Endpoint: none beyond auth — `occupancy()` cannot fail (pure in-memory).
- Frontend: any fetch error silently keeps the generic banner; the poll
  keeps trying while waiting (a broken status display must never break the
  retry loop that actually starts the run).

## Testing

- Unit (tests/test_runpool.py): `occupancy()` on an empty pool
  (`{busy:0, max:3, autopilot:0, manual:0}`); with a mix of manual +
  autopilot live entries; reservations counted; exited entries not counted.
- `tsc --noEmit` + `next build` clean (frontend change is one page).
- Live check: with one run in flight, `curl` the endpoint as a client
  token → counts match; banner text renders counts while a second client
  waits (manual spot check alongside normal use — no full smoke needed).

## Out of scope (future)

- Real waiting queue with positions and ETA.
- Always-on occupancy badge on the Create page; admin slot panel.
- Exposing per-run detail (would need per-client filtering rules).
