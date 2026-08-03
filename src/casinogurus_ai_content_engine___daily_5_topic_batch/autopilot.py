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
    """Fill every known format with {enabled, frequency_per_week} defaults;
    unknown keys are dropped (the API 400s on them before we get here)."""
    src = content_types or {}
    out: dict[str, dict] = {}
    for fmt in AUTOPILOT_CAPS:
        entry = src.get(fmt) or {}
        out[fmt] = {
            "enabled": bool(entry.get("enabled", False)),
            "frequency_per_week": int(entry.get("frequency_per_week", 0) or 0),
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
