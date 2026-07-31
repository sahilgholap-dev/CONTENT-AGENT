"""Unit tests for the pure portal-scope helpers in auth.py.

These run without a database or Supabase: they cover the claim-shape
normalisation (new client_ids list vs legacy single client_id) and the
scope resolution every /api/portal endpoint relies on.
"""

import pytest
from fastapi import HTTPException

from casinogurus_ai_content_engine___daily_5_topic_batch.auth import (
    allowed_client_ids,
    resolve_portal_scope,
)


# --------------------------- allowed_client_ids --------------------------- #

def test_new_shape_list():
    assert allowed_client_ids({"role": "client", "client_ids": ["a", "b"]}) == ["a", "b"]


def test_legacy_single_client_id():
    assert allowed_client_ids({"role": "client", "client_id": "gemmere"}) == ["gemmere"]


def test_client_ids_wins_over_stale_legacy_key():
    assert allowed_client_ids({"client_ids": ["a"], "client_id": "stale"}) == ["a"]


def test_empty_list_falls_back_to_legacy():
    assert allowed_client_ids({"client_ids": [], "client_id": "x"}) == ["x"]


def test_dedupes_and_drops_blanks():
    assert allowed_client_ids({"client_ids": ["a", "", "a", None, "b"]}) == ["a", "b"]


def test_no_clients_anywhere():
    assert allowed_client_ids({"role": "client"}) == []


# --------------------------- resolve_portal_scope ------------------------- #

def test_admin_without_param_is_422():
    with pytest.raises(HTTPException) as e:
        resolve_portal_scope(None, None)
    assert e.value.status_code == 422


def test_admin_with_param_passes_through():
    assert resolve_portal_scope(None, "anything") == "anything"


def test_single_client_defaults_without_param():
    assert resolve_portal_scope(["gemmere"], None) == "gemmere"


def test_single_client_matching_param():
    assert resolve_portal_scope(["gemmere"], "gemmere") == "gemmere"


def test_forged_param_is_403():
    with pytest.raises(HTTPException) as e:
        resolve_portal_scope(["gemmere"], "casinogurus")
    assert e.value.status_code == 403


def test_multi_client_without_param_is_422():
    with pytest.raises(HTTPException) as e:
        resolve_portal_scope(["a", "b"], None)
    assert e.value.status_code == 422


def test_multi_client_with_valid_param():
    assert resolve_portal_scope(["a", "b"], "b") == "b"
