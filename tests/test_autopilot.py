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
    assert cfg["blog"] == {"enabled": True, "frequency_per_week": 1, "topic_source": "pool"}
    assert cfg["youtube_short"] == {"enabled": False, "frequency_per_week": 0, "topic_source": "pool"}


def test_merge_content_types_is_a_per_format_patch():
    from casinogurus_ai_content_engine___daily_5_topic_batch.autopilot import merge_content_types

    current = normalize_config({
        "linkedin_post": {"enabled": True, "frequency_per_week": 2, "topic_source": "pool"},
    })
    merged = merge_content_types(current, {"blog": {"enabled": True, "frequency_per_week": 1}})
    # The patched format changes…
    assert merged["blog"]["enabled"] is True
    # …and the unmentioned format keeps its current settings (never silently disabled).
    assert merged["linkedin_post"] == {"enabled": True, "frequency_per_week": 2, "topic_source": "pool"}


def test_topic_source_normalized_and_validated():
    cfg = normalize_config({"blog": {"enabled": True, "topic_source": "auto"}})
    assert cfg["blog"]["topic_source"] == "auto"
    cfg = normalize_config({"blog": {"topic_source": "bogus"}})
    assert cfg["blog"]["topic_source"] == "pool"
    problems = validate_config({"blog": {"frequency_per_week": 1, "topic_source": "bogus"}})
    assert any("topic_source" in p for p in problems)
    assert validate_config({"blog": {"frequency_per_week": 1, "topic_source": "manual"}}) == []


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


def test_project_nights_continues_the_spread():
    from casinogurus_ai_content_engine___daily_5_topic_batch.autopilot import project_nights

    # freq 1 = Mondays; after Mon Aug 10 the next two are Aug 17 and Aug 24.
    assert project_nights(1, date(2026, 8, 10), 2) == [date(2026, 8, 17), date(2026, 8, 24)]
    assert project_nights(0, date(2026, 8, 10), 3) == []


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
    calls = {"updates": [], "selected": [], "claimed": []}
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
    monkeypatch.setattr(storage_mod, "claim_queue_item", lambda qid: calls["claimed"].append(qid) or True)
    return calls


def _item(eligible_delta_hours: float, qid: str = "q1", client: str = "frugaa", sid: str = "s1") -> dict:
    return {
        "id": qid,
        "client_id": client,
        "content_type": "short_form",
        "format": "linkedin_post",
        "topic": "T1",
        "suggestion_id": sid,
        "eligible_from": NOW - timedelta(hours=eligible_delta_hours),
        "state": "pending",
    }


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


class _Http409(Exception):
    status_code = 409


def test_tick_transient_409_leaves_item_queued(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(1), _item(1, qid="q2", client="gemmere", sid="s2")])
    def boom_then_ok(item):
        if item["id"] == "q1":
            raise _Http409("engine at capacity")
        return {"run_id": "r2"}
    action = tick(_cap(budget=2), None, boom_then_ok, now_utc=NOW)
    assert action == "generate:q2"
    assert ("q1", {"state": "pending", "note": "waiting: engine busy"}) in calls["updates"]
    assert ("q2", {"state": "generating", "generate_run_id": "r2", "note": None}) in calls["updates"]


def test_tick_poison_item_fails_without_starving_others(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(1), _item(1, qid="q2", client="gemmere", sid="s2")])
    def poison_then_ok(item):
        if item["id"] == "q1":
            raise ValueError("format 'linkedin_post' is not enabled")
        return {"run_id": "r2"}
    action = tick(_cap(budget=2), None, poison_then_ok, now_utc=NOW)
    assert action == "generate:q2"
    failed = [f for qid, f in calls["updates"] if qid == "q1" and f.get("state") == "failed"]
    assert failed and failed[0]["note"].startswith("launch failed:")


def test_tick_skips_item_claimed_by_another_process(monkeypatch):
    calls = _stub_storage(monkeypatch, due=[_item(1)])
    monkeypatch.setattr(storage_mod, "claim_queue_item", lambda qid: False)
    launched = []
    action = tick(_cap(budget=2), None, lambda item: launched.append(item) or {"run_id": "r1"}, now_utc=NOW)
    assert action == "idle"
    assert launched == []


def test_tick_refill_failure_does_not_consume_budget(monkeypatch):
    import casinogurus_ai_content_engine___daily_5_topic_batch.autopilot as autopilot_mod
    calls = _stub_storage(monkeypatch, due=[_item(1)])
    monkeypatch.setattr(storage_mod, "list_enabled_autopilot_configs", lambda: [{"client_id": "gemmere"}])
    monkeypatch.setattr(autopilot_mod, "plan_client", lambda cfg, now: {"blog": 1})
    def failing_suggest(cid, ct, fmt):
        raise RuntimeError("spawn failed")
    launched = []
    action = tick(_cap(budget=1), failing_suggest, lambda item: launched.append(item) or {"run_id": "r1"}, now_utc=NOW)
    assert action == "refill-failed:gemmere:blog,generate:q1"
    assert [i["id"] for i in launched] == ["q1"]
