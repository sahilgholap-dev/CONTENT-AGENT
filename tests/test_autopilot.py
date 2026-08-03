"""Unit tests for autopilot's pure planning logic (no DB, no Supabase):
caps/config validation, night spreading, timezone math.
"""

from datetime import date, datetime, timezone

from casinogurus_ai_content_engine___daily_5_topic_batch.autopilot import (
    AUTOPILOT_CAPS,
    local_midnight_utc,
    nights_for_frequency,
    normalize_config,
    today_local,
    upcoming_nights,
    validate_config,
    validate_timezone,
)


# ------------------------------ validate_config ---------------------------- #

def test_valid_config_passes():
    assert validate_config({"blog": {"enabled": True, "frequency_per_week": 2}}) == []


def test_over_cap_rejected_per_format():
    problems = validate_config({
        "blog": {"enabled": True, "frequency_per_week": 3},
        "linkedin_post": {"enabled": True, "frequency_per_week": 6},
    })
    assert any("blog" in p and "0..2" in p for p in problems)
    assert any("linkedin_post" in p and "0..5" in p for p in problems)


def test_unknown_format_rejected():
    problems = validate_config({"instagram_caption": {"enabled": True, "frequency_per_week": 1}})
    assert any("unknown format" in p for p in problems)


def test_negative_and_non_int_rejected():
    assert validate_config({"blog": {"frequency_per_week": -1}}) != []
    assert validate_config({"blog": {"frequency_per_week": "lots"}}) != []


def test_normalize_fills_all_known_formats():
    cfg = normalize_config({"blog": {"enabled": True, "frequency_per_week": 1}})
    assert set(cfg) == set(AUTOPILOT_CAPS)
    assert cfg["blog"] == {"enabled": True, "frequency_per_week": 1}
    assert cfg["youtube_short"] == {"enabled": False, "frequency_per_week": 0}


# ------------------------------ night spreading ---------------------------- #

def test_nights_for_frequency_sizes_match():
    for freq in range(6):
        assert len(nights_for_frequency(freq)) == freq


def test_upcoming_nights_weekdays_and_horizon():
    # Monday 2026-08-03; freq 3 -> Mon/Wed/Fri within the next 7 days.
    nights = upcoming_nights(3, date(2026, 8, 3))
    assert nights == [date(2026, 8, 5), date(2026, 8, 7), date(2026, 8, 10)]
    assert all(n.weekday() in (0, 2, 4) for n in nights)


def test_upcoming_nights_zero_freq_empty():
    assert upcoming_nights(0, date(2026, 8, 3)) == []


# ------------------------------ timezone math ------------------------------ #

def test_local_midnight_utc_kolkata():
    # Midnight IST is 18:30 UTC the previous day.
    dt = local_midnight_utc(date(2026, 8, 10), "Asia/Kolkata")
    assert dt == datetime(2026, 8, 9, 18, 30, tzinfo=timezone.utc)


def test_local_midnight_utc_new_york_dst():
    # August = EDT (UTC-4), so midnight local is 04:00 UTC same day.
    dt = local_midnight_utc(date(2026, 8, 10), "America/New_York")
    assert dt == datetime(2026, 8, 10, 4, 0, tzinfo=timezone.utc)


def test_today_local_crosses_date_line():
    # 20:00 UTC is already "tomorrow" in Kolkata (01:30 IST).
    now = datetime(2026, 8, 9, 20, 0, tzinfo=timezone.utc)
    assert today_local("Asia/Kolkata", now) == date(2026, 8, 10)
    assert today_local("America/New_York", now) == date(2026, 8, 9)


def test_validate_timezone():
    assert validate_timezone("Asia/Kolkata")
    assert validate_timezone("America/New_York")
    assert not validate_timezone("Mars/Olympus_Mons")


# ------------------------------ tick decisions ----------------------------- #

from datetime import timedelta

import casinogurus_ai_content_engine___daily_5_topic_batch.storage as storage_mod
from casinogurus_ai_content_engine___daily_5_topic_batch.autopilot import tick

NOW = datetime(2026, 8, 10, 1, 0, tzinfo=timezone.utc)


def _stub_storage(monkeypatch, *, due=(), unreviewed=0):
    calls = {"updates": [], "selected": []}
    monkeypatch.setattr(storage_mod, "generating_queue_items", lambda: [])
    monkeypatch.setattr(storage_mod, "list_enabled_autopilot_configs", lambda: [])
    monkeypatch.setattr(storage_mod, "due_queue_items", lambda limit=20: list(due))
    monkeypatch.setattr(storage_mod, "count_unreviewed_autopilot_drafts", lambda cid: unreviewed)
    monkeypatch.setattr(
        storage_mod, "update_queue_item", lambda qid, **f: calls["updates"].append((qid, f))
    )
    monkeypatch.setattr(
        storage_mod,
        "set_suggestions_status",
        lambda ids, st, generate_run_id=None: calls["selected"].append((list(ids), st)),
    )
    monkeypatch.setattr(storage_mod, "get_run", lambda rid: None)
    return calls


def _item(eligible_delta_hours: float) -> dict:
    return {
        "id": "q1",
        "client_id": "frugaa",
        "content_type": "short_form",
        "format": "linkedin_post",
        "topic": "T1",
        "suggestion_id": "s1",
        "eligible_from": NOW - timedelta(hours=eligible_delta_hours),
    }


def test_tick_busy_engine_launches_nothing(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(1)])
    action = tick(lambda: False, None, None, now_utc=NOW)
    assert action == "busy"
    assert calls["updates"] == []


def test_tick_marks_missed_after_catch_up_window(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(25)])
    action = tick(lambda: True, None, lambda item: {"run_id": "r1"}, now_utc=NOW)
    assert action == "idle"
    assert calls["updates"] == [("q1", {"state": "missed", "note": "missed its night and the 24h catch-up window"})]


def test_tick_guardrail_skips_backlogged_client(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(1)], unreviewed=10)
    action = tick(lambda: True, None, lambda item: {"run_id": "r1"}, now_utc=NOW)
    assert action == "idle"
    assert calls["updates"] == [("q1", {"note": "waiting: too many unreviewed autopilot drafts"})]


def test_tick_launches_eligible_item(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(1)])
    launched = []
    action = tick(lambda: True, None, lambda item: launched.append(item) or {"run_id": "r9"}, now_utc=NOW)
    assert action == "generate:q1"
    assert launched[0]["topic"] == "T1"
    assert ("q1", {"state": "generating", "generate_run_id": "r9", "note": None}) in calls["updates"]
    assert calls["selected"] == [(["s1"], "selected")]
