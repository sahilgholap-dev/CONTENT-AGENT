"""Supabase-Auth JWT verification for the FastAPI backend.

The frontend logs users in with Supabase Auth and sends the resulting access
token to this API. Most requests carry it as ``Authorization: Bearer <jwt>``;
the two browser features that cannot set headers -- the SSE log stream
(``EventSource``) and the ZIP download link -- pass it as ``?access_token=<jwt>``
instead, so this dependency accepts either.

Verification is key-type aware, because Supabase has moved to **asymmetric JWT
signing keys**:

* Asymmetric tokens (``ES256`` / ``RS256`` / ``EdDSA``) are verified against the
  project's public **JWKS** endpoint, discovered from ``SUPABASE_URL``. This is
  the current default and needs no shared secret.
* ``HS256`` tokens are verified with the legacy shared secret in
  ``SUPABASE_JWT_SECRET`` (supported for as long as the legacy secret is active).

For local development only, set ``AUTH_DISABLED=1`` to bypass verification.
"""

from __future__ import annotations

import os

from fastapi import Depends, HTTPException, Query, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

# auto_error=False so we can also look for the token in the query string before
# deciding the request is unauthenticated.
_bearer = HTTPBearer(auto_error=False)

_ASYMMETRIC_ALGS = ("ES256", "RS256", "EdDSA")
_jwk_client = None  # lazily created jwt.PyJWKClient


def _auth_disabled() -> bool:
    return os.environ.get("AUTH_DISABLED", "").strip().lower() in ("1", "true", "yes", "on")


def _supabase_url() -> str:
    url = os.environ.get("SUPABASE_URL")
    if not url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Server auth is misconfigured: SUPABASE_URL is not set (needed to "
            "fetch the JWKS for asymmetric token verification).",
        )
    return url.rstrip("/")


def _get_jwk_client():
    """Return a cached PyJWKClient pointed at the project's JWKS endpoint."""
    global _jwk_client
    if _jwk_client is None:
        from jwt import PyJWKClient

        _jwk_client = PyJWKClient(f"{_supabase_url()}/auth/v1/.well-known/jwks.json")
    return _jwk_client


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_user(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    access_token: str | None = Query(default=None),
) -> dict:
    """FastAPI dependency: validate the Supabase JWT and return its claims.

    Raises 401 if the token is missing or invalid. Returns the decoded payload
    (``sub``, ``email``, ``role``, ...) so handlers can identify the user.
    """
    if _auth_disabled():
        return {
            "sub": "local-dev",
            "email": "local@dev",
            "role": "authenticated",
            "app_metadata": {"role": "admin", "client_id": None},
        }

    token = None
    if creds is not None and creds.scheme.lower() == "bearer":
        token = creds.credentials
    elif access_token:
        token = access_token

    if not token:
        raise _unauthorized("Missing bearer token.")

    import jwt

    audience = os.environ.get("SUPABASE_JWT_AUD", "authenticated")
    try:
        alg = jwt.get_unverified_header(token).get("alg", "")
    except jwt.PyJWTError as e:
        raise _unauthorized(f"Malformed token: {e}")

    try:
        if alg in _ASYMMETRIC_ALGS:
            signing_key = _get_jwk_client().get_signing_key_from_jwt(token)
            payload = jwt.decode(
                token,
                signing_key.key,
                algorithms=list(_ASYMMETRIC_ALGS),
                audience=audience,
            )
        elif alg == "HS256":
            secret = os.environ.get("SUPABASE_JWT_SECRET")
            if not secret:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Received an HS256 token but SUPABASE_JWT_SECRET is not set.",
                )
            payload = jwt.decode(token, secret, algorithms=["HS256"], audience=audience)
        else:
            raise _unauthorized(f"Unsupported token algorithm: {alg or 'none'}")
    except jwt.PyJWTError as e:
        raise _unauthorized(f"Invalid token: {e}")

    return payload


# --------------------------------------------------------------------------- #
# Role-based access (portal split)
#
# Roles live in Supabase ``app_metadata`` -- settable ONLY server-side (via the
# Admin API / service_role key), and embedded in every JWT, so neither the
# user nor the frontend can forge them:
#     app_metadata: {"role": "admin"}                              # internal team
#     app_metadata: {"role": "client", "client_id": "casinogurus"} # portal login
# --------------------------------------------------------------------------- #

def portal_role(payload: dict) -> str | None:
    return ((payload.get("app_metadata") or {}).get("role")) or None


def require_admin(user: dict = Depends(require_user)) -> dict:
    """FastAPI dependency: valid token AND app_metadata.role == 'admin'."""
    if portal_role(user) != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required.",
        )
    return user


def require_client(user: dict = Depends(require_user)) -> dict:
    """FastAPI dependency for the client portal.

    Admits role == 'client' (scoped to their own client_id) and also admins
    (who may browse any client's portal view). Returns the claims with a
    normalised ``portal_client_id`` key: the token's client_id for clients,
    or None for admins (portal endpoints must then take it from the request).
    """
    role = portal_role(user)
    if role == "admin":
        user = dict(user)
        user["portal_client_id"] = None
        return user
    if role != "client":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Portal access required.",
        )
    client_id = (user.get("app_metadata") or {}).get("client_id")
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This login is not linked to a client. Contact your administrator.",
        )
    user = dict(user)
    user["portal_client_id"] = client_id
    return user
