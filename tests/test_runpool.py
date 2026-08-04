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
    pool.mark_settled("run-a")
    assert pool.due_settlement() == []


def test_crash_signal_survives_same_client_relaunch(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    proc, _ = start(pool, "a", run_id="r1")
    proc.exit(1)
    pool.reap()                    # exited_at recorded
    start(pool, "a", run_id="r2")  # relaunch inside grace clobbers the entry
    clock.advance(CRASH_GRACE_SECONDS + 1)
    due = pool.due_settlement()
    assert [e.run_id for e in due] == ["r1"]
    pool.mark_settled("r1")
    assert pool.due_settlement() == []


def test_unsettled_entry_survives_ttl_reap(tmp_path, clock):
    pool = make_pool(tmp_path, clock)
    proc, _ = start(pool, "a", run_id="r1")
    proc.exit(1)
    pool.reap()
    clock.advance(FINISHED_TTL_SECONDS + 1)
    pool.reap()
    assert pool.entry_for("a") is None        # entry dropped from the pool
    due = pool.due_settlement()
    assert [e.run_id for e in due] == ["r1"]  # crash signal preserved
    pool.mark_settled("r1")
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
