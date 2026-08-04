# Concurrent Runs (Worker Pool) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multiple clients' content generates in parallel (pool of 3 subprocesses, configurable) while runs stay serial within each client and one slot is always kept free for manual runs.

**Architecture:** A new pure-logic `runpool.py` module owns slot accounting (reserve/commit/abort under one lock, capacity snapshots, exited-entry reaping, per-run log paths). `app.py` swaps its single `_run_state` slot for a `RunPool` instance and gives every run its own `logs/run-<run_id>.log`. `autopilot.tick` swaps its boolean `engine_idle` callback for a `capacity()` snapshot and launches up to its budget per tick. Spec: `docs/superpowers/specs/2026-08-04-concurrent-runs-design.md`.

**Tech Stack:** Python 3 / FastAPI / psycopg (Postgres) / pytest. No new dependencies.

## Global Constraints

- `MAX_CONCURRENT_RUNS` env var, default **3**, floor 1; invalid values fall back to 3.
- At most **one live run per client**, ever (reservations count).
- Autopilot may hold at most `MAX − 1` slots; when `MAX == 1` it may use the slot only when idle (today's behavior).
- 409 stays the status code for "can't start now" (the Create wizard's auto-retry depends on it).
- Run DB statuses: `queued` (insert default), `running`, `succeeded`, `failed`. Non-terminal = `queued`/`running`.
- Per-run logs live in `logs/run-<run_id>.log` under the project root (`logs/` is gitignored; distinct from the existing `runs/` artifacts dir).
- The `[AGENT_RUN] {json}` header must remain line 1 of every run log (SSE + progress parse it).
- Tests run with `python -m pytest tests/ -v` from the project root. All existing tests must stay green.
- Windows dev box: never bulk-edit files via PowerShell Get/Set-Content; use precise editor tools.
- Do NOT push; commits stay local (user pushes `old-origin main` themselves).

---

### Task 1: `runpool.py` — pool bookkeeping module

**Files:**
- Create: `src/casinogurus_ai_content_engine___daily_5_topic_batch/runpool.py`
- Test: `tests/test_runpool.py`

**Interfaces:**
- Consumes: nothing (stdlib only; no FastAPI/DB/subprocess imports).
- Produces (used by Tasks 2–5):
  - `max_slots() -> int` — env-var parse.
  - `PoolBusy(Exception)` with `.detail: str`.
  - `RunEntry` dataclass: `client_id, origin, run_id, process, log_file, started_at, exited_at, settled`, method `live() -> bool`.
  - `RunPool(logs_dir: str, max_slots_fn=max_slots, clock=time.monotonic)` with:
    - `reserve(client_id, origin) -> None` (raises `PoolBusy`)
    - `commit(client_id, run_id, process, log_file) -> None`
    - `abort(client_id) -> None`
    - `entry_for(client_id) -> RunEntry | None`
    - `entry_by_run_id(run_id) -> RunEntry | None`
    - `latest_active() -> RunEntry | None`
    - `capacity() -> dict` with keys `free: int`, `autopilot_budget: int`, `busy_clients: set[str]`
    - `reap() -> None`, `due_settlement() -> list[RunEntry]`, `mark_settled(client_id) -> None`
    - `log_path(run_id) -> str`, `cleanup_old_logs() -> None`
  - Constants: `FINISHED_TTL_SECONDS = 300`, `CRASH_GRACE_SECONDS = 30`, `LOG_RETENTION_DAYS = 14`, `DEFAULT_MAX_CONCURRENT_RUNS = 3`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_runpool.py` with exactly:

```python
"""Unit tests for the run pool: slot math, per-client exclusivity,
reservations, reaping/TTL, crash settlement, and log housekeeping.

No FastAPI, no DB, no real subprocesses - FakeProc stands in for anything
with poll(), and a manual clock drives TTL/grace behavior."""

import os
import time

import pytest

from casinogurus_ai_content_engine___daily_5_topic_batch.runpool import (
    CRASH_GRACE_SECONDS,
    FINISHED_TTL_SECONDS,
    PoolBusy,
    RunPool,
    max_slots,
)


class FakeProc:
    def __init__(self):
        self._code = None

    def poll(self):
        return self._code

    def exit(self, code=0):
        self._code = code


class FakeLog:
    def __init__(self):
        self.closed = False

    def close(self):
        self.closed = True


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, s):
        self.t += s


@pytest.fixture()
def clock():
    return Clock()


def make_pool(tmp_path, clock, slots=3):
    return RunPool(logs_dir=str(tmp_path), max_slots_fn=lambda: slots, clock=clock)


def start(pool, client, origin="manual", run_id=None):
    pool.reserve(client, origin)
    proc, log = FakeProc(), FakeLog()
    pool.commit(client, run_id or f"run-{client}", proc, log)
    return proc, log


# -------------------------------- gate -------------------------------- #

def test_second_run_for_same_client_is_rejected(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    start(pool, "frugaa")
    with pytest.raises(PoolBusy, match="already has a run"):
        pool.reserve("frugaa", "manual")


def test_pool_full_rejects_new_client(tmp_path, clock):
    pool = make_pool(tmp_path, clock, slots=2)
    start(pool, "a")
    start(pool, "b")
    with pytest.raises(PoolBusy, match="capacity"):
        pool.reserve("c", "manual")


def test_reservation_holds_slot_until_abort(tmp_path, clock):
    pool = make_pool(tmp_path, clock, slots=1)
    pool.reserve("a", "manual")  # reserved, never committed
    with pytest.raises(PoolBusy):
        pool.reserve("b", "manual")
    pool.abort("a")
    pool.reserve("b", "manual")  # slot freed


def test_exited_run_frees_slot_and_client(tmp_path, clock):
    pool = make_pool(tmp_path, clock, slots=1)
    proc, _ = start(pool, "a")
    proc.exit(0)
    start(pool, "a")  # same client can run again immediately


# ------------------------------ capacity ------------------------------ #

def test_budget_keeps_one_slot_for_humans(tmp_path, clock):
    pool = make_pool(tmp_path, clock, slots=3)
    assert pool.capacity() == {"free": 3, "autopilot_budget": 2, "busy_clients": set()}


def test_budget_counts_live_autopilot_runs(tmp_path, clock):
    pool = make_pool(tmp_path, clock, slots=3)
    start(pool, "a", origin="autopilot")
    snap = pool.capacity()
    assert snap["free"] == 2
    assert snap["autopilot_budget"] == 1
    assert snap["busy_clients"] == {"a"}
    start(pool, "b", origin="autopilot")
    assert pool.capacity()["autopilot_budget"] == 0  # manual slot preserved


def test_max_one_behaves_like_idle_gate(tmp_path, clock):
    pool = make_pool(tmp_path, clock, slots=1)
    assert pool.capacity()["autopilot_budget"] == 1  # idle: may use the slot
    start(pool, "a")
    assert pool.capacity()["autopilot_budget"] == 0  # busy: nothing


def test_manual_runs_do_not_consume_autopilot_cap(tmp_path, clock):
    pool = make_pool(tmp_path, clock, slots=3)
    start(pool, "a", origin="manual")
    snap = pool.capacity()
    assert snap["free"] == 2
    assert snap["autopilot_budget"] == 2


# ------------------------ reaping & settlement ------------------------ #

def test_reap_closes_log_and_drops_entry_after_ttl(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    proc, log = start(pool, "a")
    proc.exit(0)
    pool.reap()  # records exited_at
    assert pool.entry_for("a") is not None  # lingers within TTL
    clock.advance(FINISHED_TTL_SECONDS + 1)
    pool.reap()
    assert pool.entry_for("a") is None
    assert log.closed


def test_due_settlement_after_grace_and_mark_settled(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    proc, _ = start(pool, "a")
    proc.exit(1)
    pool.reap()
    assert pool.due_settlement() == []  # inside grace window
    clock.advance(CRASH_GRACE_SECONDS + 1)
    due = pool.due_settlement()
    assert [e.client_id for e in due] == ["a"]
    pool.mark_settled("a")
    assert pool.due_settlement() == []


# ------------------------------ queries ------------------------------- #

def test_latest_active_returns_newest_live_run(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    start(pool, "a", run_id="r1")
    clock.advance(5)
    start(pool, "b", run_id="r2")
    assert pool.latest_active().run_id == "r2"


def test_entry_by_run_id(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    start(pool, "a", run_id="r1")
    assert pool.entry_by_run_id("r1").client_id == "a"
    assert pool.entry_by_run_id("nope") is None


# -------------------------------- logs -------------------------------- #

def test_log_path_creates_dir_and_is_per_run(tmp_path, clock):
    pool = RunPool(logs_dir=str(tmp_path / "logs"), max_slots_fn=lambda: 3, clock=clock)
    p = pool.log_path("abc")
    assert p.endswith(os.path.join("logs", "run-abc.log"))
    assert os.path.isdir(str(tmp_path / "logs"))


def test_cleanup_deletes_only_old_run_logs(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    old = tmp_path / "run-old.log"
    old.write_text("x")
    fresh = tmp_path / "run-new.log"
    fresh.write_text("x")
    keep = tmp_path / "other.txt"
    keep.write_text("x")
    fifteen_days_ago = time.time() - 15 * 86400
    os.utime(str(old), (fifteen_days_ago, fifteen_days_ago))
    pool.cleanup_old_logs()
    assert not old.exists()
    assert fresh.exists()
    assert keep.exists()


# ------------------------------- config ------------------------------- #

def test_max_slots_env(monkeypatch):
    monkeypatch.delenv("MAX_CONCURRENT_RUNS", raising=False)
    assert max_slots() == 3
    monkeypatch.setenv("MAX_CONCURRENT_RUNS", "5")
    assert max_slots() == 5
    monkeypatch.setenv("MAX_CONCURRENT_RUNS", "0")
    assert max_slots() == 1
    monkeypatch.setenv("MAX_CONCURRENT_RUNS", "banana")
    assert max_slots() == 3
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python -m pytest tests/test_runpool.py -v`
Expected: FAIL at import — `ModuleNotFoundError: No module named '...runpool'`

- [ ] **Step 3: Write the implementation**

Create `src/casinogurus_ai_content_engine___daily_5_topic_batch/runpool.py` with exactly:

```python
"""In-process run pool: which crew subprocesses are alive, per-client
exclusivity, and the slot math that keeps one slot free for humans.

Pure bookkeeping - no FastAPI, no DB, no subprocess imports. app.py owns
the subprocesses and the DB; this module only decides who may start and
remembers who is running. Anything with a poll() -> None|int method can
play the part of a process (tests use fakes)."""

from __future__ import annotations

import glob
import os
import threading
import time
from dataclasses import dataclass

DEFAULT_MAX_CONCURRENT_RUNS = 3
FINISHED_TTL_SECONDS = 300  # keep exited entries so /run-progress can show the final state
CRASH_GRACE_SECONDS = 30    # exited this long with a non-terminal DB row => crashed
LOG_RETENTION_DAYS = 14


def max_slots() -> int:
    """MAX_CONCURRENT_RUNS env var, default 3, floor 1 (bad values -> default)."""
    try:
        return max(1, int(os.environ.get("MAX_CONCURRENT_RUNS", "")))
    except ValueError:
        return DEFAULT_MAX_CONCURRENT_RUNS


class PoolBusy(Exception):
    def __init__(self, detail: str):
        super().__init__(detail)
        self.detail = detail


@dataclass
class RunEntry:
    client_id: str
    origin: str                     # 'manual' | 'autopilot'
    run_id: str | None = None       # None while reserved (gate passed, spawn pending)
    process: object | None = None   # anything with poll() -> None | int
    log_file: object | None = None
    started_at: float = 0.0         # pool clock
    exited_at: float | None = None  # pool clock, first reap that saw poll() != None
    settled: bool = False           # crash settlement done (see due_settlement)

    def live(self) -> bool:
        """Reservations hold their slot until commit/abort; committed
        entries are live while the process runs."""
        if self.process is None:
            return True
        return self.process.poll() is None


class RunPool:
    """One entry per client (per-client exclusivity is the dict key).
    Exited entries linger FINISHED_TTL_SECONDS so read surfaces can still
    resolve the just-finished run, but they stop counting toward slots."""

    def __init__(self, logs_dir: str, max_slots_fn=max_slots, clock=time.monotonic):
        self._logs_dir = logs_dir
        self._max = max_slots_fn
        self._clock = clock
        self._lock = threading.Lock()
        self._entries: dict[str, RunEntry] = {}

    # -------------------------------- gate -------------------------------- #

    def reserve(self, client_id: str, origin: str) -> None:
        """Claim a slot before any slow work (DB insert, spawn). Check and
        claim happen under one lock so two requests can't both pass."""
        with self._lock:
            self._reap_locked()
            existing = self._entries.get(client_id)
            if existing is not None:
                if existing.live():
                    raise PoolBusy(f"client '{client_id}' already has a run in progress")
                self._close_log(existing)  # replacing a lingering finished entry
            live = sum(1 for e in self._entries.values() if e.live())
            if live >= self._max():
                raise PoolBusy("engine at capacity, try again shortly")
            self._entries[client_id] = RunEntry(
                client_id=client_id, origin=origin, started_at=self._clock()
            )

    def commit(self, client_id: str, run_id: str, process, log_file) -> None:
        with self._lock:
            e = self._entries[client_id]
            e.run_id, e.process, e.log_file = run_id, process, log_file

    def abort(self, client_id: str) -> None:
        """Release a reservation that never became a run (validation or
        spawn failed). No-op if the entry was already committed."""
        with self._lock:
            e = self._entries.get(client_id)
            if e is not None and e.process is None:
                del self._entries[client_id]

    # ------------------------------ queries ------------------------------- #

    def entry_for(self, client_id: str) -> RunEntry | None:
        """The client's entry: live, or recently exited (within TTL)."""
        with self._lock:
            self._reap_locked()
            return self._entries.get(client_id)

    def entry_by_run_id(self, run_id: str) -> RunEntry | None:
        with self._lock:
            self._reap_locked()
            for e in self._entries.values():
                if e.run_id == run_id:
                    return e
            return None

    def latest_active(self) -> RunEntry | None:
        """Most recently started live run (admin terminal default)."""
        with self._lock:
            self._reap_locked()
            live = [e for e in self._entries.values() if e.live() and e.process is not None]
            return max(live, key=lambda e: e.started_at) if live else None

    def capacity(self) -> dict:
        """Slot snapshot for the autopilot tick. Autopilot may hold at most
        max-1 slots (all of them when max is 1) so a manual run always fits."""
        with self._lock:
            self._reap_locked()
            live = [e for e in self._entries.values() if e.live()]
            m = self._max()
            free = max(0, m - len(live))
            ap_cap = m - 1 if m > 1 else m
            ap_live = sum(1 for e in live if e.origin == "autopilot")
            return {
                "free": free,
                "autopilot_budget": max(0, min(free, ap_cap - ap_live)),
                "busy_clients": {e.client_id for e in live},
            }

    # ------------------------- reaping & settlement ------------------------ #

    def reap(self) -> None:
        with self._lock:
            self._reap_locked()

    def _reap_locked(self) -> None:
        now = self._clock()
        for cid in list(self._entries):
            e = self._entries[cid]
            if e.process is None or e.process.poll() is None:
                continue
            if e.exited_at is None:
                e.exited_at = now
            if now - e.exited_at >= FINISHED_TTL_SECONDS:
                self._close_log(e)
                del self._entries[cid]

    @staticmethod
    def _close_log(e: RunEntry) -> None:
        try:
            if e.log_file is not None:
                e.log_file.close()
        except Exception:
            pass

    def due_settlement(self) -> list[RunEntry]:
        """Exited entries past the crash grace period that nobody settled
        yet. The caller checks the DB row, marks the run failed if the
        process died without reporting, then calls mark_settled()."""
        with self._lock:
            self._reap_locked()
            now = self._clock()
            return [
                e
                for e in self._entries.values()
                if not e.settled
                and e.exited_at is not None
                and now - e.exited_at >= CRASH_GRACE_SECONDS
            ]

    def mark_settled(self, client_id: str) -> None:
        with self._lock:
            e = self._entries.get(client_id)
            if e is not None:
                e.settled = True

    # -------------------------------- logs -------------------------------- #

    def log_path(self, run_id: str) -> str:
        os.makedirs(self._logs_dir, exist_ok=True)
        return os.path.join(self._logs_dir, f"run-{run_id}.log")

    def cleanup_old_logs(self) -> None:
        """Best-effort delete of run logs older than LOG_RETENTION_DAYS."""
        cutoff = time.time() - LOG_RETENTION_DAYS * 86400
        try:
            for path in glob.glob(os.path.join(self._logs_dir, "run-*.log")):
                try:
                    if os.path.getmtime(path) < cutoff:
                        os.remove(path)
                except OSError:
                    pass
        except OSError:
            pass
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_runpool.py -v`
Expected: all 15 PASS

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `python -m pytest tests/ -v`
Expected: everything green (new + existing)

- [ ] **Step 6: Commit**

```bash
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/runpool.py tests/test_runpool.py
git commit -m "feat(pool): run pool module - slots, per-client exclusivity, reaping"
```

---

### Task 2: `autopilot.tick` — capacity budget, multi-launch per tick

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/autopilot.py` (the `tick` function, currently ~line 231)
- Test: `tests/test_autopilot.py` (tick section, currently lines ~127–196)

**Interfaces:**
- Consumes: `capacity()` callback returning `{"free": int, "autopilot_budget": int, "busy_clients": set[str]}` (Task 1's `RunPool.capacity` shape; tests fake it).
- Produces: `tick(capacity, launch_suggest, launch_generate, now_utc=None) -> str` returning `'busy'` | `'idle'` | comma-joined actions (`refill:<client>:<format>`, `generate:<queue_id>`). Task 5 wires `_pool.capacity` in as the first argument.

- [ ] **Step 1: Update the tick tests and add budget tests**

In `tests/test_autopilot.py`, replace `_item` (lines ~155–164) with:

```python
def _item(eligible_delta_hours: float, qid: str = "q1", client: str = "frugaa", sid: str = "s1") -> dict:
    return {
        "id": qid,
        "client_id": client,
        "content_type": "short_form",
        "format": "linkedin_post",
        "topic": "T1",
        "suggestion_id": sid,
        "eligible_from": NOW - timedelta(hours=eligible_delta_hours),
    }
```

Replace the four existing tick tests (lines ~167–196) with:

```python
def _cap(budget=1, busy=()):
    """Fake pool capacity callback (see runpool.RunPool.capacity)."""
    return lambda: {"free": budget, "autopilot_budget": budget, "busy_clients": set(busy)}


def test_tick_no_budget_launches_nothing(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(1)])
    action = tick(_cap(budget=0), None, None, now_utc=NOW)
    assert action == "busy"
    assert calls["updates"] == []


def test_tick_marks_missed_after_catch_up_window(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(25)])
    action = tick(_cap(), None, lambda item: {"run_id": "r1"}, now_utc=NOW)
    assert action == "idle"
    assert calls["updates"] == [("q1", {"state": "missed", "note": "missed its night and the 24h catch-up window"})]


def test_tick_guardrail_skips_backlogged_client(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(1)], unreviewed=10)
    action = tick(_cap(), None, lambda item: {"run_id": "r1"}, now_utc=NOW)
    assert action == "idle"
    assert calls["updates"] == [("q1", {"note": "waiting: too many unreviewed autopilot drafts"})]


def test_tick_launches_eligible_item(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(1)])
    launched = []
    action = tick(_cap(), None, lambda item: launched.append(item) or {"run_id": "r9"}, now_utc=NOW)
    assert action == "generate:q1"
    assert launched[0]["topic"] == "T1"
    assert ("q1", {"state": "generating", "generate_run_id": "r9", "note": None}) in calls["updates"]
    assert calls["selected"] == [(["s1"], "selected")]


def test_tick_launches_multiple_clients_up_to_budget(monkeypatch):
    calls = _stub_storage(
        monkeypatch, due=[_item(1), _item(1, qid="q2", client="gemmere", sid="s2")]
    )
    launched = []
    action = tick(
        _cap(budget=2), None,
        lambda item: launched.append(item) or {"run_id": f"r{len(launched)}"},
        now_utc=NOW,
    )
    assert action == "generate:q1,generate:q2"
    assert [i["id"] for i in launched] == ["q1", "q2"]


def test_tick_budget_caps_launches(monkeypatch):
    calls = _stub_storage(
        monkeypatch, due=[_item(1), _item(1, qid="q2", client="gemmere", sid="s2")]
    )
    action = tick(_cap(budget=1), None, lambda item: {"run_id": "r1"}, now_utc=NOW)
    assert action == "generate:q1"
    states = [f.get("state") for _, f in calls["updates"]]
    assert states.count("generating") == 1


def test_tick_serial_within_client(monkeypatch):
    # Two due items for the SAME client: only the oldest launches this tick.
    calls = _stub_storage(monkeypatch, due=[_item(1), _item(1, qid="q2", sid="s2")])
    action = tick(_cap(budget=2), None, lambda item: {"run_id": "r1"}, now_utc=NOW)
    assert action == "generate:q1"


def test_tick_skips_client_with_live_run(monkeypatch):
    calls = _stub_storage(
        monkeypatch, due=[_item(1), _item(1, qid="q2", client="gemmere", sid="s2")]
    )
    action = tick(_cap(budget=2, busy={"frugaa"}), None, lambda item: {"run_id": "r1"}, now_utc=NOW)
    assert action == "generate:q2"


def test_tick_refill_consumes_budget_before_generates(monkeypatch):
    import casinogurus_ai_content_engine___daily_5_topic_batch.autopilot as autopilot_mod

    calls = _stub_storage(monkeypatch, due=[_item(1)])
    monkeypatch.setattr(
        storage_mod, "list_enabled_autopilot_configs", lambda: [{"client_id": "gemmere"}]
    )
    monkeypatch.setattr(autopilot_mod, "plan_client", lambda cfg, now: {"blog": 1})
    suggested = []
    action = tick(
        _cap(budget=1),
        lambda cid, ct, fmt: suggested.append((cid, ct, fmt)),
        lambda item: {"run_id": "r1"},
        now_utc=NOW,
    )
    assert action == "refill:gemmere:blog"
    assert suggested == [("gemmere", "long_form", "blog")]
    assert calls["updates"] == []  # budget exhausted before the due item
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `python -m pytest tests/test_autopilot.py -v`
Expected: the tick tests FAIL (old `tick` treats the `_cap()` dict-returning callback as truthy `engine_idle` — multi-launch/budget asserts break; `test_tick_no_budget_launches_nothing` fails because a dict with `autopilot_budget: 0` is still truthy)

- [ ] **Step 3: Rewrite `tick`**

In `autopilot.py`, replace the whole `tick` function with:

```python
def tick(capacity, launch_suggest, launch_generate, now_utc: datetime | None = None) -> str:
    """One scheduler pass. Returns a short action string (for logs/tests):
    'busy' | 'idle' | comma-joined 'refill:<client>:<format>' and
    'generate:<queue_id>' entries, one per launch this tick.

    Order matters: reap finished work, plan everyone's week, then launch up
    to the pool's autopilot budget (the pool keeps one slot free for manual
    runs — humans always come first). Refills go before generates because
    they unblock the next planning pass, and no client gets more than one
    launch per tick — runs are serial within a client."""
    from casinogurus_ai_content_engine___daily_5_topic_batch import storage

    now = now_utc or datetime.now(timezone.utc)

    # 1. Reap: settle items whose generate run finished.
    for item in storage.generating_queue_items():
        run = storage.get_run(str(item["generate_run_id"])) if item.get("generate_run_id") else None
        if run is None:
            storage.update_queue_item(str(item["id"]), state="failed", note="run row missing")
        elif run["status"] == "succeeded":
            storage.update_queue_item(str(item["id"]), state="done")
        elif run["status"] in ("failed", "cancelled"):
            storage.update_queue_item(
                str(item["id"]), state="failed", note=(run.get("error") or "run failed")[:300]
            )

    # 2. Plan every enabled, non-paused business; collect pool shortages.
    shortages: list[tuple[str, str]] = []
    for cfg in storage.list_enabled_autopilot_configs():
        for fmt, missing in plan_client(cfg, now).items():
            if missing > 0:
                shortages.append((cfg["client_id"], fmt))

    # 3. How many slots may autopilot claim right now?
    snap = capacity()
    budget = int(snap.get("autopilot_budget", 0))
    busy = set(snap.get("busy_clients") or ())
    if budget <= 0:
        return "busy"

    actions: list[str] = []

    # 4. Refills first: they unblock the next planning pass.
    for client_id, fmt in shortages:
        if budget <= 0:
            break
        if client_id in busy:
            continue
        launch_suggest(client_id, FORMAT_CONTENT_TYPE[fmt], fmt)
        busy.add(client_id)
        budget -= 1
        actions.append(f"refill:{client_id}:{fmt}")

    # 5. Oldest eligible items across clients.
    for item in storage.due_queue_items():
        if budget <= 0:
            break
        if item["eligible_from"] < now - timedelta(hours=CATCH_UP_HOURS):
            storage.update_queue_item(
                str(item["id"]), state="missed",
                note="missed its night and the 24h catch-up window",
            )
            continue
        if storage.count_unreviewed_autopilot_drafts(item["client_id"]) >= UNREVIEWED_DRAFTS_LIMIT:
            storage.update_queue_item(
                str(item["id"]), note="waiting: too many unreviewed autopilot drafts"
            )
            continue
        if item["client_id"] in busy:
            continue
        result = launch_generate(item)
        storage.update_queue_item(
            str(item["id"]), state="generating", generate_run_id=result["run_id"], note=None
        )
        if item.get("suggestion_id"):
            storage.set_suggestions_status(
                [str(item["suggestion_id"])], "selected", generate_run_id=result["run_id"]
            )
        busy.add(item["client_id"])
        budget -= 1
        actions.append(f"generate:{item['id']}")

    return ",".join(actions) if actions else "idle"
```

(Steps 1, 2, and the missed/guardrail bodies are byte-identical to today — only the capacity snapshot, the loops' budget/busy bookkeeping, and the return value change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `python -m pytest tests/test_autopilot.py -v`
Expected: all PASS (planner/timezone tests untouched, 9 tick tests green)

- [ ] **Step 5: Full suite**

Run: `python -m pytest tests/ -v`
Expected: green. (app.py still passes `_engine_idle` — that breaks only at runtime, not in tests, and Task 5 fixes the wiring. Do not start the backend between Tasks 2 and 5.)

- [ ] **Step 6: Commit**

```bash
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/autopilot.py tests/test_autopilot.py
git commit -m "feat(autopilot): tick launches up to pool budget across clients"
```

---

### Task 3: `app.py` launch path — pool gate + per-run log files

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py` (module top ~lines 82–85; `_start_agent_run` ~lines 1154–1232)

**Interfaces:**
- Consumes: `runpool.RunPool`, `PoolBusy`, `reserve/commit/abort`, `log_path`, `cleanup_old_logs` (Task 1).
- Produces: module-level `_pool: RunPool` used by Tasks 4 and 5. `_start_agent_run` behavior: 409 when the client is busy or the pool is full; per-run log at `_pool.log_path(run_id)`; response shape unchanged.

- [ ] **Step 1: Replace the module-level run state**

In `app.py`, replace:

```python
# Single-run guard: at most one crew subprocess at a time (small internal tool).
_run_state: dict = {"process": None, "log_file": None}
```

with:

```python
# Run pool: parallel across clients, serial within a client, one slot always
# kept free for manual runs. MAX_CONCURRENT_RUNS env var sets the size.
_pool = runpool.RunPool(logs_dir=os.path.join(_PROJECT_ROOT, "logs"))
```

and add to the package imports near the top (next to the existing `from casinogurus_ai_content_engine___daily_5_topic_batch import ...` imports):

```python
from casinogurus_ai_content_engine___daily_5_topic_batch import runpool
```

Keep `LOG_PATH` for now — Task 4 removes its last readers, then deletes it.

- [ ] **Step 2: Replace the gate in `_start_agent_run`**

Delete these lines at the top of `_start_agent_run` (~1154–1156):

```python
    proc = _run_state["process"]
    if proc is not None and proc.poll() is None:
        raise HTTPException(status_code=409, detail="Agent is already running")
```

(The format/client/topic validations that follow stay exactly where they are — they're read-only and must run before a slot is claimed.)

- [ ] **Step 3: Claim a slot, then create the run and spawn**

Replace the section from `run_row = storage.create_run(...)` through `_run_state.update(process=process, log_file=log_file)` (~lines 1189–1232) with:

```python
    # Claim a pool slot before the DB insert and spawn. Check-and-claim is
    # atomic inside the pool, so two simultaneous requests can't both pass.
    try:
        _pool.reserve(client_id, origin)
    except runpool.PoolBusy as e:
        raise HTTPException(status_code=409, detail=e.detail)

    try:
        run_row = storage.create_run(
            client_id, content_type, format_id, topic=topic, kind=kind, topics=topics, origin=origin
        )

        # With a pinned topic (user-provided or shortlist) the first pipeline task
        # STRUCTURES the given topic instead of discovering one — label the
        # terminal stage honestly so it doesn't look like discovery re-ran.
        stage_labels = ["Topic Suggestions"] if kind == "suggest" else list(spec.stage_labels)
        if kind != "suggest" and (topic or topics) and stage_labels and stage_labels[0] == "Topic Discovery":
            stage_labels[0] = "Structuring Selected Topic" + ("s" if topics and len(topics) > 1 else "")

        _pool.cleanup_old_logs()
        log_file = open(_pool.log_path(str(run_row["id"])), "w", encoding="utf-8")
        # First log line self-describes the run so the SSE terminal can label the
        # stages and header without another request (SSE replays from file start).
        log_file.write(
            "[AGENT_RUN] "
            + json.dumps(
                {
                    "run_id": str(run_row["id"]),
                    "client_id": client["id"],
                    "client_name": client["display_name"],
                    "content_type": spec.content_type,
                    "format": spec.id,
                    "topic": topic,
                    "kind": kind,
                    "stage_labels": stage_labels,
                }
            )
            + "\n"
        )
        log_file.flush()

        cmd = [sys.executable, "-u", "-m", f"{PACKAGE}.main", "run", "--run-id", str(run_row["id"])]
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUNBUFFERED"] = "1"
        try:
            process = subprocess.Popen(
                cmd, cwd=_PROJECT_ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env
            )
            threading.Thread(target=_tee_output, args=(process, log_file), daemon=True).start()
        except Exception as e:
            log_file.close()
            storage.update_run(run_row["id"], status="failed", error=f"spawn failed: {e}")
            raise HTTPException(status_code=500, detail=str(e))
    except BaseException:
        _pool.abort(client_id)  # release the reservation on ANY failure
        raise

    _pool.commit(client_id, str(run_row["id"]), process, log_file)
```

The `return {...}` block after it is unchanged.

- [ ] **Step 4: Compile check + full suite**

Run: `python -c "from casinogurus_ai_content_engine___daily_5_topic_batch import app"`
Expected: imports cleanly (no NameError — the progress/SSE endpoints still reference `_run_state` at this point ONLY if Step 1 missed them; they don't — they're fixed in Task 4, and they only *read* at request time, not import time... verify the import succeeds; if it fails on `_run_state`, Task 4's edits must land before committing)

Run: `python -m pytest tests/ -v`
Expected: green

**Note:** after Step 1, `portal_run_progress` (~line 1037), `agent_logs` (~line 1476), and `_engine_idle` (~line 1539) still reference the deleted `_run_state` — they fail at *request* time, not import time. Tasks 3+4+5 must all land before the backend is started; they commit separately but only Task 5's commit leaves the app runnable. If you prefer atomic safety, stage Tasks 3–5 and run the suite once at the end of Task 5 before committing all three — the default here is separate commits with the backend left stopped.

- [ ] **Step 5: Commit**

```bash
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py
git commit -m "feat(pool): launch path claims pool slots, per-run log files"
```

---

### Task 4: `app.py` read surfaces — progress + SSE resolve per-run logs

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py` (`portal_run_progress` ~lines 1026–1066; `agent_logs` ~lines 1465–1497)

**Interfaces:**
- Consumes: `_pool.entry_for(client_id)`, `_pool.entry_by_run_id(run_id)`, `_pool.latest_active()`, `_pool.log_path(run_id)`, `RunEntry.live()` (Tasks 1 & 3).
- Produces: `GET /api/portal/run-progress` — same response shape as today. `GET /api/agent-logs?run_id=<optional>` — same SSE event shape as today.

- [ ] **Step 1: Rewrite `portal_run_progress`'s run resolution**

Replace the body between `empty = {...}` and the `labels = ...` line with:

```python
    empty = {"active": False, "stage": 0, "total": 0, "label": None}
    cid = _portal_cid(user, client_id)
    entry = _pool.entry_for(cid)
    if entry is None or entry.run_id is None:
        return empty
    running = entry.live()
    path = _pool.log_path(entry.run_id)
    if not os.path.exists(path):
        return empty
    header: dict | None = None
    completed = 0
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if header is None and line.startswith("[AGENT_RUN] "):
                    try:
                        header = json.loads(line[len("[AGENT_RUN] "):])
                    except Exception:
                        header = {}
                if "[AGENT_PROGRESS] Task Completed" in line:
                    completed += 1
    except OSError:
        return empty
    if not header or header.get("client_id") != cid:
        return empty
```

(The `labels`/`total`/`stage`/return block below stays identical.) The docstring's meaning shifts slightly — update it to say the run is resolved from the pool per client, so another client's concurrent run is invisible by construction, with the header check kept as defense in depth. The pool keeps finished entries for 5 minutes, so the endpoint still reports the final `active: False` state right after a run completes, exactly like today's lingering `agent.log` did.

- [ ] **Step 2: Rewrite `agent_logs` to select a run**

Replace the whole endpoint with:

```python
@api.get("/agent-logs")
async def agent_logs(run_id: str | None = None):
    """Live tail of one run's log as SSE. ?run_id= selects a specific run;
    default is the most recently started active run (matches the old
    single-run behavior). No such run -> a stream that closes immediately."""
    entry = _pool.entry_by_run_id(run_id) if run_id else _pool.latest_active()
    path = _pool.log_path(entry.run_id) if entry and entry.run_id else None
    proc = entry.process if entry else None

    async def event_stream():
        if path is None or not os.path.exists(path):
            yield "event: close\ndata: {}\n\n"
            return
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            while True:
                line = f.readline()
                if line:
                    yield f"data: {json.dumps({'text': line})}\n\n"
                else:
                    if proc is None or proc.poll() is not None:
                        # read any remaining lines before closing
                        line = f.readline()
                        if line:
                            yield f"data: {json.dumps({'text': line})}\n\n"
                            continue
                        yield "event: close\ndata: {}\n\n"
                        break
                    await asyncio.sleep(0.5)
                    # Clear internal EOF buffer state
                    f.seek(f.tell())

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
```

- [ ] **Step 3: Delete `LOG_PATH`**

Remove the `LOG_PATH = os.path.join(_PROJECT_ROOT, "agent.log")` line, then verify nothing references it:

Run: `grep -n "LOG_PATH" src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py`
Expected: no matches

- [ ] **Step 4: Compile check + full suite**

Run: `python -c "from casinogurus_ai_content_engine___daily_5_topic_batch import app"` then `python -m pytest tests/ -v`
Expected: import clean, suite green (only `_engine_idle` in lifespan still references `_run_state`; Task 5 removes it — backend stays stopped until then)

- [ ] **Step 5: Commit**

```bash
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py
git commit -m "feat(pool): progress + SSE terminal resolve per-run logs"
```

---

### Task 5: Lifespan wiring — orphan sweep, capacity callback, crash settlement

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/storage.py` (add `fail_orphaned_runs` near `update_run`, ~line 556)
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py` (lifespan, ~lines 1510–1572)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `_pool.capacity` (passed as `tick`'s `capacity` callback — Task 2's expected shape), `_pool.due_settlement()`, `_pool.mark_settled()` (Task 1).
- Produces: `storage.fail_orphaned_runs() -> int` — marks `queued`/`running` runs failed, returns count.

- [ ] **Step 1: Add the storage helper**

In `storage.py`, directly after `update_run`:

```python
def fail_orphaned_runs() -> int:
    """Mark non-terminal runs failed (a restart killed their subprocess).
    Called once at startup, before the scheduler starts launching, so
    nothing looks alive forever and autopilot re-plans their queue items."""
    with connection() as conn:
        rows = conn.execute(
            """UPDATE runs
               SET status = 'failed', error = 'server restarted', finished_at = now()
               WHERE status IN ('queued', 'running')
               RETURNING id"""
        ).fetchall()
        return len(rows)
```

(No unit test — storage functions are deliberately not unit-tested in this codebase, there's no DB test harness. It's exercised in Task 6's live smoke.)

- [ ] **Step 2: Add the orphan sweep to lifespan**

In `lifespan`, right after the profile-seeding `try/except` block and before the autopilot section:

```python
    # Any run rows still non-terminal are corpses from a previous process
    # (a deploy or crash killed their subprocess) — mark them failed so
    # nothing looks alive forever and autopilot re-plans their queue items.
    try:
        n = storage.fail_orphaned_runs()
        if n:
            print(f"[startup] marked {n} orphaned run(s) as failed (server restart)")
    except Exception as e:
        print(f"[startup] WARNING: orphan sweep failed: {e}")
```

- [ ] **Step 3: Swap the scheduler wiring**

In the autopilot section of `lifespan`, delete `_engine_idle` and replace the loop:

```python
        def _launch_suggest(client_id: str, content_type: str, fmt: str) -> dict:
            return _start_agent_run(client_id, content_type, fmt, None, kind="suggest", origin="autopilot")

        def _launch_generate(item: dict) -> dict:
            # discover slots run the classic find-a-topic-and-write flow; the
            # rest pin the planned topic (exactly one piece either way).
            topics = None if item.get("discover") else [item["topic"]]
            return _start_agent_run(
                item["client_id"], item["content_type"], item["format"], None,
                kind="generate", topics=topics, origin="autopilot",
            )

        def _settle_crashed() -> None:
            # A process that exited without its run row reaching a terminal
            # status crashed (OOM/kill) — record the failure so queue items
            # settle and the client's night re-plans.
            for entry in _pool.due_settlement():
                run = storage.get_run(entry.run_id) if entry.run_id else None
                if run and run["status"] in ("queued", "running"):
                    storage.update_run(
                        entry.run_id,
                        status="failed",
                        error="run process exited without reporting status",
                        finished_at=datetime.now(timezone.utc),
                    )
                _pool.mark_settled(entry.client_id)

        async def _autopilot_loop():
            while True:
                try:
                    await asyncio.to_thread(_settle_crashed)
                    action = await asyncio.to_thread(
                        autopilot.tick, _pool.capacity, _launch_suggest, _launch_generate
                    )
                    if action not in ("idle", "busy"):
                        print(f"[autopilot] {action}", flush=True)
                except Exception as e:
                    print(f"[autopilot] tick error: {e}", flush=True)
                await asyncio.sleep(60)
```

(`_launch_suggest`/`_launch_generate` are unchanged — shown for placement.) Check `app.py`'s imports include `from datetime import datetime, timezone`; add it if only one of the two names is imported.

- [ ] **Step 4: Gitignore the log dir**

Append to `.gitignore`:

```
# Per-run crew logs (regenerable; auto-deleted after 14 days)
logs/
agent.log
```

- [ ] **Step 5: Verify no stale references, compile, full suite**

Run: `grep -n "_run_state\|_engine_idle" src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py`
Expected: no matches

Run: `python -c "from casinogurus_ai_content_engine___daily_5_topic_batch import app"` then `python -m pytest tests/ -v`
Expected: import clean, whole suite green — the app is now runnable again

- [ ] **Step 6: Commit**

```bash
git add src/casinogurus_ai_content_engine___daily_5_topic_batch/storage.py src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py .gitignore
git commit -m "feat(pool): lifespan wires pool capacity, orphan sweep, crash settlement"
```

---

### Task 6: Live multi-client smoke

**Files:** none (verification only; scratchpad scripts allowed)

**Interfaces:**
- Consumes: everything above, running against the real backend + shared DB.

**Setup notes for the engineer:** the backend runs from the project root with `uvicorn` on :8000 (see previous session's process: real auth `AUTH_DISABLED=0`; a scratchpad script `frugaa_admin.py` mints admin JWTs for API calls). Test clients: use two non-production clients (e.g. `frugaa` plus one other test client with a profile). Autopilot is currently OFF for all clients.

- [ ] **Step 1: Start the backend with a 3-slot pool**

Run (from project root): `$env:MAX_CONCURRENT_RUNS = "3"; uvicorn casinogurus_ai_content_engine___daily_5_topic_batch.app:app --port 8000`
Expected: startup logs show `[startup] autopilot scheduler running` and (first boot after the change) possibly `marked N orphaned run(s) as failed`

- [ ] **Step 2: Verify the orphan sweep is idempotent**

Restart the backend once.
Expected: second boot prints no orphan-sweep line (0 rows) — nothing was running.

- [ ] **Step 3: Enable autopilot for two clients with manual topics**

Via the API (admin surface), for each of the two test clients: PUT autopilot config enabling `linkedin_post` (frequency 2), add manual topics via `POST /api/autopilot/topics`, then force one queue item per client eligible now:

```sql
UPDATE autopilot_queue SET eligible_from = now() - interval '1 hour'
WHERE client_id IN ('<client_a>', '<client_b>') AND state = 'pending';
```

- [ ] **Step 4: Watch a parallel launch**

Within ~2 ticks (≤2 min), expect the backend log to print ONE line containing both launches, e.g. `[autopilot] generate:<qa>,generate:<qb>`.
Verify: two `logs/run-*.log` files growing simultaneously; `GET /api/autopilot/queue` shows both items `generating`; each client's `GET /api/portal/run-progress` reports its own distinct `run_id`.

- [ ] **Step 5: Verify the reserved manual slot**

While both autopilot runs are live (2 of 3 slots), start a manual run for a THIRD client via `POST /api/run-agent`.
Expected: 200 `started` (the reserved slot). Then try a second run for the SAME third client.
Expected: 409 `client '...' already has a run in progress`.

- [ ] **Step 6: Verify completion + SSE**

Let the runs finish. Expected: queue items flip to `done` on the next tick, pieces appear in each client's Drafts with `origin: autopilot`, and `GET /api/agent-logs?run_id=<one of them>` replays that run's log and closes.

- [ ] **Step 7: Clean up test state**

Disable autopilot for both test clients (PUT config with the format disabled — pending slots delete themselves). The third client's manual-run draft can stay (it's a normal draft in their feed). Leave `MAX_CONCURRENT_RUNS` unset (default 3).

- [ ] **Step 8: Final full verification**

Run: `python -m pytest tests/ -v`
Expected: all green. Frontend untouched this feature — no tsc/build needed. Update `docs/session-handoff.md` if the session ends here.

---

## Self-review notes

- Spec coverage: registry/per-run logs (T1, T3), launch gate (T3), autopilot budget + multi-launch (T2, T5), progress/SSE (T4), orphan sweep + crash settlement + log cleanup (T1, T3, T5), gitignore (T5), tests + live smoke (T1, T2, T6). "What doesn't change" honored: no frontend edits, API shapes stable.
- Known sequencing hazard: between Task 3 Step 1 and Task 5 Step 3 the backend must not be started (stale `_run_state` references in not-yet-edited functions). Called out in Tasks 3–5.
- `mark_settled` keys by client_id: safe because an entry is replaced only via `reserve`, which can't happen while the exited entry lingers unsettled — reserve replaces it and the fresh entry has `settled=False`, `exited_at=None`, so a due settlement can't be lost to a replacement race within one tick's window... it CAN be dropped if the client starts a new run inside the 30s grace: acceptable — the orphan sweep at next restart is the backstop, and the crashed row also gets caught by `tick`'s reap only if a queue item points at it. Edge accepted for an internal tool.
