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
        self._orphans: dict[str, RunEntry] = {}  # run_id -> unsettled entry evicted from _entries

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
                self._orphan_if_unsettled(existing)
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
                self._orphan_if_unsettled(e)
                del self._entries[cid]

    @staticmethod
    def _close_log(e: RunEntry) -> None:
        try:
            if e.log_file is not None:
                e.log_file.close()
        except Exception:
            pass

    def _orphan_if_unsettled(self, e: RunEntry) -> None:
        """Keep the crash signal of an evicted entry: due_settlement() must
        still surface it so its DB row gets checked. Bounded so a dev setup
        with no settlement loop can't grow it forever."""
        if e.exited_at is None or e.settled or not e.run_id:
            return
        self._orphans[e.run_id] = e
        while len(self._orphans) > 100:
            oldest = min(self._orphans.values(), key=lambda o: o.exited_at or 0.0)
            del self._orphans[oldest.run_id]

    def due_settlement(self) -> list[RunEntry]:
        """Exited entries past the crash grace period that nobody settled
        yet. The caller checks the DB row, marks the run failed if the
        process died without reporting, then calls mark_settled()."""
        with self._lock:
            self._reap_locked()
            now = self._clock()
            due = [
                e
                for e in self._entries.values()
                if not e.settled
                and e.exited_at is not None
                and now - e.exited_at >= CRASH_GRACE_SECONDS
            ]
            due.extend(
                e
                for e in self._orphans.values()
                if now - (e.exited_at or now) >= CRASH_GRACE_SECONDS
            )
            return due

    def mark_settled(self, run_id: str) -> None:
        with self._lock:
            self._orphans.pop(run_id, None)
            for e in self._entries.values():
                if e.run_id == run_id:
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
