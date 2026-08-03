"""Autopilot: per-business overnight scheduled drafting.

Pure planning logic lives here (caps, night spreading, timezone math,
config validation) so it is unit-testable without a database. The scheduler
loop (planner/executor/reaper, added in a later phase) composes these with
storage helpers and the existing run machinery: a planned piece is just a
pinned-single-topic generate run whose topic came from the client's
topic_suggestions pool.

Spec: docs/superpowers/specs/2026-08-03-autopilot-design.md
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

# Weekly hard caps per format (slider max client-side, 400 server-side).
AUTOPILOT_CAPS: dict[str, int] = {
    "blog": 2,
    "linkedin_post": 5,
    "youtube_long": 4,
    "youtube_short": 4,
}

# format id -> content_type (the run row needs both).
FORMAT_CONTENT_TYPE: dict[str, str] = {
    "blog": "long_form",
    "linkedin_post": "short_form",
    "youtube_long": "video",
    "youtube_short": "video",
}

DEFAULT_TIMEZONE = "Asia/Kolkata"

# frequency_per_week -> weekday indices (Mon=0) that get one piece each.
# One piece per format per night, so N/week means N distinct nights.
NIGHT_SPREAD: dict[int, tuple[int, ...]] = {
    0: (),
    1: (0,),
    2: (0, 3),
    3: (0, 2, 4),
    4: (0, 1, 3, 4),
    5: (0, 1, 2, 3, 4),
}

# How each format sources its topics:
#   pool   - draw from the client's topic_suggestions (picked ones first);
#            research a fresh round when the pool runs dry
#   manual - only topics the client typed in (added to the pool as picked);
#            never auto-research — nights stay open until they add more
#   auto   - fully automatic: the agent discovers a fresh topic on the night
#            (classic discover-and-generate), no veto topic shown
TOPIC_SOURCES = ("pool", "manual", "auto")

# Queue-row topic label for auto (discover) slots.
AUTO_TOPIC_LABEL = "Fresh topic — the agent decides on the night"

# Generation guardrail: skip a client's autopilot runs while this many of
# their autopilot drafts sit unreviewed in Drafts.
UNREVIEWED_DRAFTS_LIMIT = 10

# Missed-slot rule: run late within this window, then mark missed.
CATCH_UP_HOURS = 24


def validate_timezone(tz: str) -> bool:
    try:
        ZoneInfo(tz)
        return True
    except Exception:
        return False


def normalize_config(content_types: dict | None) -> dict:
    """Fill every known format with {enabled, frequency_per_week,
    topic_source} defaults; unknown keys are dropped (the API 400s on them
    before we get here)."""
    src = content_types or {}
    out: dict[str, dict] = {}
    for fmt in AUTOPILOT_CAPS:
        entry = src.get(fmt) or {}
        source = entry.get("topic_source") or "pool"
        out[fmt] = {
            "enabled": bool(entry.get("enabled", False)),
            "frequency_per_week": int(entry.get("frequency_per_week", 0) or 0),
            "topic_source": source if source in TOPIC_SOURCES else "pool",
        }
    return out


def validate_config(content_types: dict | None) -> list[str]:
    """Problems with a PUT config payload ([] = valid). Caps are enforced
    here — never trust the client's slider."""
    problems: list[str] = []
    src = content_types or {}
    for fmt in src:
        if fmt not in AUTOPILOT_CAPS:
            problems.append(f"unknown format '{fmt}'")
    for fmt, cap in AUTOPILOT_CAPS.items():
        entry = src.get(fmt)
        if entry is None:
            continue
        try:
            freq = int(entry.get("frequency_per_week", 0) or 0)
        except (TypeError, ValueError):
            problems.append(f"{fmt}: frequency_per_week must be an integer")
            continue
        if freq < 0 or freq > cap:
            problems.append(f"{fmt}: frequency_per_week must be 0..{cap}")
        source = entry.get("topic_source")
        if source is not None and source not in TOPIC_SOURCES:
            problems.append(f"{fmt}: topic_source must be one of {'/'.join(TOPIC_SOURCES)}")
    return problems


def nights_for_frequency(freq: int) -> tuple[int, ...]:
    """Weekday indices (Mon=0) that receive one piece for this frequency."""
    return NIGHT_SPREAD.get(max(0, min(freq, 5)), ())


def upcoming_nights(freq: int, today_local: date, horizon_days: int = 7) -> list[date]:
    """The local dates within the horizon (starting tomorrow) whose weekday
    is in the spread for this frequency. Tonight's items must already exist
    by the previous day (veto window), so planning starts at tomorrow."""
    weekdays = set(nights_for_frequency(freq))
    return [
        d
        for i in range(1, horizon_days + 1)
        if (d := today_local + timedelta(days=i)).weekday() in weekdays
    ]


def local_midnight_utc(night: date, tz: str) -> datetime:
    """The UTC instant at which `night` begins in the client's timezone —
    the moment a queue item becomes eligible and its veto window closes."""
    return datetime.combine(night, time(0, 0), tzinfo=ZoneInfo(tz)).astimezone(timezone.utc)


def today_local(tz: str, now_utc: datetime | None = None) -> date:
    now = now_utc or datetime.now(timezone.utc)
    return now.astimezone(ZoneInfo(tz)).date()


# --------------------------------------------------------------------------- #
# Planner + executor (composed with storage; the app's lifespan runs tick()
# every ~60s and injects engine_idle/launch callables so this module never
# imports app.py)
# --------------------------------------------------------------------------- #

def plan_client(cfg: dict, now_utc: datetime | None = None) -> dict[str, int]:
    """Ensure queue rows exist for the client's coming week (one per enabled
    format per spread night), drawing topics oldest-first from the client's
    unused suggestion pool. Returns per-format shortage counts — slots that
    could not be filled because the pool ran dry."""
    from casinogurus_ai_content_engine___daily_5_topic_batch import storage

    client_id = cfg["client_id"]
    tz = cfg.get("timezone") or DEFAULT_TIMEZONE
    today = today_local(tz, now_utc)
    shortages: dict[str, int] = {}

    for fmt, entry in (cfg.get("content_types") or {}).items():
        if fmt not in AUTOPILOT_CAPS or not (entry or {}).get("enabled"):
            continue
        freq = int((entry or {}).get("frequency_per_week", 0) or 0)
        if freq <= 0:
            continue
        source = (entry or {}).get("topic_source") or "pool"
        nights = upcoming_nights(freq, today)
        taken = storage.queue_nights_taken(client_id, fmt, nights)
        open_nights = [n for n in nights if n not in taken]
        if not open_nights:
            continue

        if source == "auto":
            # Fully automatic: the slot exists (schedule, pause, guardrail
            # and Skip all apply) but the agent discovers the topic on the
            # night — nothing to veto in advance.
            for night in open_nights:
                storage.insert_queue_item(
                    client_id, FORMAT_CONTENT_TYPE[fmt], fmt,
                    AUTO_TOPIC_LABEL, None, night, local_midnight_utc(night, tz),
                    discover=True,
                )
            continue

        pool = storage.unused_suggestions(client_id, fmt, limit=len(open_nights))
        for night, sug in zip(open_nights, pool):
            storage.insert_queue_item(
                client_id,
                FORMAT_CONTENT_TYPE[fmt],
                fmt,
                sug["topic"],
                str(sug["id"]),
                night,
                local_midnight_utc(night, tz),
            )
        # Only pool mode auto-researches when short; manual mode waits for
        # the client to add more of their own topics.
        if source == "pool" and len(pool) < len(open_nights):
            shortages[fmt] = len(open_nights) - len(pool)
    return shortages


def tick(engine_idle, launch_suggest, launch_generate, now_utc: datetime | None = None) -> str:
    """One scheduler pass. Returns a short action string (for logs/tests):
    'busy' | 'idle' | 'refill:<client>:<format>' | 'generate:<queue_id>'.

    Order matters: reap finished work, plan everyone's week, then — only if
    the engine is idle (humans always come first) — launch at most ONE run:
    a pool refill if any planner came up short, else the oldest eligible
    queue item across all clients (cross-client fairness)."""
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

    # 3. Launching anything requires an idle engine — manual runs always win.
    if not engine_idle():
        return "busy"

    # 4. Refills first: they unblock the next planning pass.
    if shortages:
        client_id, fmt = shortages[0]
        launch_suggest(client_id, FORMAT_CONTENT_TYPE[fmt], fmt)
        return f"refill:{client_id}:{fmt}"

    # 5. Oldest eligible item across clients.
    for item in storage.due_queue_items():
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
        result = launch_generate(item)
        storage.update_queue_item(
            str(item["id"]), state="generating", generate_run_id=result["run_id"], note=None
        )
        if item.get("suggestion_id"):
            storage.set_suggestions_status(
                [str(item["suggestion_id"])], "selected", generate_run_id=result["run_id"]
            )
        return f"generate:{item['id']}"

    return "idle"
