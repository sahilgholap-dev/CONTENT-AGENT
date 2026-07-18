"""Thin client for the Supabase Auth Admin API (GoTrue /auth/v1/admin).

Used for portal user management: creating client logins, setting roles in
app_metadata, password resets, and disabling accounts. Requires the
``SUPABASE_SERVICE_ROLE_KEY`` env var -- SERVER-SIDE ONLY (Railway). That key
bypasses all row security; it must never reach the frontend or a client build.
"""

from __future__ import annotations

import os
import secrets
import string

import httpx


class SupabaseAdminError(RuntimeError):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


def _base_url() -> str:
    url = os.environ.get("SUPABASE_URL", "").rstrip("/")
    if not url:
        raise SupabaseAdminError(500, "SUPABASE_URL is not set")
    return f"{url}/auth/v1"


def _headers() -> dict:
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not key:
        raise SupabaseAdminError(
            500, "SUPABASE_SERVICE_ROLE_KEY is not set (required for user management)"
        )
    return {"apikey": key, "Authorization": f"Bearer {key}"}


def _request(method: str, path: str, **kwargs) -> dict | list:
    with httpx.Client(timeout=15) as http:
        resp = http.request(method, f"{_base_url()}{path}", headers=_headers(), **kwargs)
    if resp.status_code >= 400:
        try:
            detail = resp.json().get("msg") or resp.json().get("message") or resp.text
        except Exception:
            detail = resp.text
        raise SupabaseAdminError(resp.status_code, f"Supabase admin API: {detail}")
    return resp.json() if resp.text else {}


def generate_temp_password(length: int = 14) -> str:
    """URL-safe-ish password with guaranteed letter/digit mix, shown once."""
    alphabet = string.ascii_letters + string.digits
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if any(c.isdigit() for c in pw) and any(c.isalpha() for c in pw):
            return pw


def list_users(per_page: int = 200) -> list[dict]:
    """All auth users (paginated under the hood)."""
    users: list[dict] = []
    page = 1
    while True:
        batch = _request("GET", f"/admin/users?page={page}&per_page={per_page}")
        # GoTrue returns {"users": [...], "aud": ...} on this endpoint.
        rows = batch.get("users", batch) if isinstance(batch, dict) else batch
        users.extend(rows)
        if len(rows) < per_page:
            return users
        page += 1


def get_user(user_id: str) -> dict:
    return _request("GET", f"/admin/users/{user_id}")


def create_user(email: str, password: str, role: str, client_id: str | None) -> dict:
    return _request(
        "POST",
        "/admin/users",
        json={
            "email": email,
            "password": password,
            "email_confirm": True,  # closed portal: no confirmation email flow
            "app_metadata": {"role": role, "client_id": client_id},
        },
    )


def update_user(user_id: str, **fields) -> dict:
    """PUT /admin/users/{id}. Accepts password, app_metadata, ban_duration, ..."""
    return _request("PUT", f"/admin/users/{user_id}", json=fields)


def set_role(user_id: str, role: str, client_id: str | None = None) -> dict:
    return update_user(user_id, app_metadata={"role": role, "client_id": client_id})


def set_password(user_id: str, password: str) -> dict:
    return update_user(user_id, password=password)


def set_banned(user_id: str, banned: bool) -> dict:
    # "none" lifts a ban; a long duration effectively disables the account.
    return update_user(user_id, ban_duration="87600h" if banned else "none")


def delete_user(user_id: str) -> dict:
    return _request("DELETE", f"/admin/users/{user_id}")
