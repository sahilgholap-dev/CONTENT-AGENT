# Multi-Client Portal Logins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One portal login can own several clients (businesses) and switch between them; admins can edit an existing login's role and client assignments.

**Architecture:** The allowed-client list lives in Supabase JWT claims as `app_metadata.client_ids` (legacy single `client_id` still honoured — no DB migration). Pure scope-resolution helpers in `auth.py` are unit-tested; every portal endpoint already funnels through one resolver in `app.py`, so scoping changes in exactly one place. The frontend threads the selected business through a single query-param hook in `lib/api.ts`.

**Tech Stack:** FastAPI + PyJWT + Supabase GoTrue Admin API (backend), Next.js 16 + Supabase JS (frontend), pytest (new dev dependency), uv.

**Spec:** `docs/superpowers/specs/2026-07-31-multi-client-logins-design.md`

## Global Constraints

- Claim shapes: new `{"role": "client", "client_ids": ["a", "b"]}`; legacy `{"role": "client", "client_id": "x"}` must keep working untouched until edited.
- Client requesting a `client_id` outside their list → **403** with generic message "You do not have access to this client." (no leak of what exists).
- Client login with zero clients → **422** at create/edit time, **403** at auth time.
- Unknown client id in `client_ids` (admin surface) → **404** naming the bad id.
- Editing your own account → **409** (as with self-disable).
- Temp passwords are returned once and never stored (existing rule — keep).
- Git: commit locally on `main`; do NOT push (user pushes to remote `main` → CONTENT-AGENT.git themselves).
- All backend commands run from the project root with `uv run ...`. Frontend commands run inside `frontend/`.
- Windows/PowerShell 5.1 environment: no `&&` chaining; run commands separately.

---

### Task 1: Pure auth helpers + pytest setup

**Files:**
- Modify: `pyproject.toml` (via `uv add --dev pytest`)
- Create: `tests/__init__.py` (empty)
- Create: `tests/test_portal_scope.py`
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/auth.py` (add two pure functions at the bottom; do NOT change `require_client` yet — that happens with its consumer in Task 2)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 2 depends on these exact signatures):
  - `allowed_client_ids(app_metadata: dict) -> list[str]`
  - `resolve_portal_scope(allowed: list[str] | None, requested: str | None) -> str` (raises `fastapi.HTTPException` with status 403/422)

- [ ] **Step 1: Add pytest as a dev dependency**

Run: `uv add --dev pytest`
Expected: `pyproject.toml` gains a `[dependency-groups] dev = ["pytest>=..."]` entry and `uv.lock` updates.

- [ ] **Step 2: Write the failing tests**

Create `tests/__init__.py` (empty file), then `tests/test_portal_scope.py`:

```python
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `uv run pytest tests/test_portal_scope.py -v`
Expected: FAIL at import — `ImportError: cannot import name 'allowed_client_ids'`.

- [ ] **Step 4: Implement the helpers**

Append to `src/casinogurus_ai_content_engine___daily_5_topic_batch/auth.py` (after `portal_role`, before `require_admin`):

```python
def allowed_client_ids(app_metadata: dict) -> list[str]:
    """Client ids this login may act for, from either claim shape.

    New shape: ``client_ids`` list. Legacy single ``client_id`` is honoured
    only when the list is absent or empty, so a stale legacy key left behind
    by a metadata merge can never widen access.
    """
    raw = app_metadata.get("client_ids")
    ids: list[str] = []
    if isinstance(raw, (list, tuple)):
        seen: set[str] = set()
        for x in raw:
            cid = str(x).strip() if x is not None else ""
            if cid and cid not in seen:
                seen.add(cid)
                ids.append(cid)
    if not ids:
        legacy = app_metadata.get("client_id")
        if legacy:
            ids = [str(legacy)]
    return ids


def resolve_portal_scope(allowed: list[str] | None, requested: str | None) -> str:
    """The effective client scope for a portal request.

    ``allowed`` is None for admins (unrestricted, but they must name a
    client) and a non-empty list for client logins (the JWT's client_ids).
    """
    if allowed is None:
        if requested:
            return requested
        raise HTTPException(
            status_code=422,
            detail="client_id query param is required when an admin calls portal endpoints",
        )
    if requested:
        if requested in allowed:
            return requested
        raise HTTPException(status_code=403, detail="You do not have access to this client.")
    if len(allowed) == 1:
        return allowed[0]
    raise HTTPException(
        status_code=422,
        detail="client_id query param is required for logins with multiple clients",
    )
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `uv run pytest tests/test_portal_scope.py -v`
Expected: 13 passed.

- [ ] **Step 6: Commit**

```bash
git add pyproject.toml uv.lock tests/__init__.py tests/test_portal_scope.py "src/casinogurus_ai_content_engine___daily_5_topic_batch/auth.py"
git commit -m "feat(auth): pure multi-client scope helpers + pytest setup"
```

---

### Task 2: Wire multi-client scope into require_client, _portal_cid, and portal /me

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/auth.py:153-179` (`require_client`)
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py:62-66` (import), `app.py:680-691` (`_portal_cid`), `app.py:724-739` (`portal_me`)

**Interfaces:**
- Consumes: `allowed_client_ids`, `resolve_portal_scope` from Task 1.
- Produces: `require_client` now sets `user["portal_client_ids"]: list[str] | None` (None = admin) and NO LONGER sets `portal_client_id`. `_portal_cid(user, client_id)` keeps its signature — all other portal endpoints stay untouched. `GET /api/portal/me` returns `{"email": str, "clients": [{"id", "display_name", "site_domain", "status"}, ...]}` (Tasks 5 uses this shape).

- [ ] **Step 1: Rewrite `require_client` in auth.py**

Replace the whole `require_client` function (lines 153-179) with:

```python
def require_client(user: dict = Depends(require_user)) -> dict:
    """FastAPI dependency for the client portal.

    Admits role == 'client' (scoped to their assigned client list) and also
    admins (who may browse any client's portal view). Returns the claims
    with a normalised ``portal_client_ids`` key: the token's allowed client
    ids for clients, or None for admins (portal endpoints must then take the
    client from the request).
    """
    role = portal_role(user)
    if role == "admin":
        user = dict(user)
        user["portal_client_ids"] = None
        return user
    if role != "client":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Portal access required.",
        )
    ids = allowed_client_ids(user.get("app_metadata") or {})
    if not ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This login is not linked to a client. Contact your administrator.",
        )
    user = dict(user)
    user["portal_client_ids"] = ids
    return user
```

Also update the role-comment block above `portal_role` (auth.py lines 133-137) to document the new shape:

```python
#     app_metadata: {"role": "admin"}                                   # internal team
#     app_metadata: {"role": "client", "client_ids": ["casinogurus"]}   # portal login
#     app_metadata: {"role": "client", "client_id": "casinogurus"}      # legacy portal login
```

- [ ] **Step 2: Rewire `_portal_cid` in app.py**

Extend the auth import at app.py line 62:

```python
from casinogurus_ai_content_engine___daily_5_topic_batch.auth import (
    allowed_client_ids,
    require_admin,
    require_client,
    require_user,
    resolve_portal_scope,
)
```

Replace `_portal_cid` (app.py lines 680-691) with:

```python
def _portal_cid(user: dict, client_id: str | None = None) -> str:
    """The effective client scope: validated against the JWT's client list
    for client logins, or the explicit ?client_id= param for admins."""
    return resolve_portal_scope(user.get("portal_client_ids"), client_id)
```

- [ ] **Step 3: Rewrite `portal_me`**

Replace `portal_me` (app.py lines 724-739) with:

```python
@portal.get("/me")
def portal_me(user: dict = Depends(require_client), client_id: str | None = Query(default=None)):
    allowed = user.get("portal_client_ids")
    if allowed is None:
        # Admin browsing a specific client's portal view.
        allowed = [_portal_cid(user, client_id)]
    clients = []
    for cid in allowed:
        c = storage.get_client(cid)
        if c:
            clients.append(
                {
                    "id": c["id"],
                    "display_name": c["display_name"],
                    "site_domain": c["site_domain"],
                    "status": c["status"],
                }
            )
    if not clients:
        raise HTTPException(status_code=404, detail="client not found")
    # Deliberately NOT the profile: it contains internal prompt engineering.
    return jsonable({"email": user.get("email"), "clients": clients})
```

- [ ] **Step 4: Verify — unit tests still pass and the app boots with correct scoping**

Run: `uv run pytest tests/ -v` → all pass.

Start a scratch server with auth bypassed (separate port; the real dev server on 8000 keeps running):

```powershell
$env:AUTH_DISABLED='1'; uv run uvicorn casinogurus_ai_content_engine___daily_5_topic_batch.app:app --port 8001
```

Then (AUTH_DISABLED token is an admin):

```powershell
# admin without client_id -> 422
curl.exe -s http://localhost:8001/api/portal/me
# admin with client_id -> {"email": "local@dev", "clients": [ ...casinogurus... ]}
curl.exe -s "http://localhost:8001/api/portal/me?client_id=casinogurus"
# batches still scope correctly
curl.exe -s "http://localhost:8001/api/portal/batches?client_id=casinogurus"
```

Expected: 422 detail mentions the query param; /me returns a one-entry `clients` array; batches returns a JSON array. Stop the scratch server afterwards.

- [ ] **Step 5: Commit**

```bash
git add "src/casinogurus_ai_content_engine___daily_5_topic_batch/auth.py" "src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py"
git commit -m "feat(portal): JWT client_ids scoping + /me returns the client list"
```

---

### Task 3: Admin user management — multi-client create, new PUT edit endpoint

**Files:**
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/supabase_admin.py:79-98` (`create_user`, `set_role`)
- Modify: `src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py:110-114` (`PortalUserCreate` model + new `PortalUserUpdate`), `app.py:491-501` (`_user_row`), `app.py:520-535` (`create_portal_user` + new helper + new PUT endpoint)

**Interfaces:**
- Consumes: `allowed_client_ids` (Task 1), `storage.get_client(cid)` (existing).
- Produces (Task 6 depends on these):
  - `POST /api/admin/users` body: `{email, role, client_ids: string[]}` (legacy `client_id` still accepted, folded in).
  - **New** `PUT /api/admin/users/{user_id}` body: `{role: "admin"|"client", client_ids: string[]}` → returns the updated user row.
  - User rows now carry `client_ids: string[]` (the `client_id` key is gone).
  - `supabase_admin.create_user(email, password, role, client_ids: list[str] | None)`, `supabase_admin.set_role(user_id, role, client_ids: list[str] | None = None)`.

- [ ] **Step 1: Update supabase_admin.py claim writing**

Replace `create_user` and `set_role` (supabase_admin.py lines 79-98) with:

```python
def _role_metadata(role: str, client_ids: list[str] | None) -> dict:
    # client_id: None deliberately overwrites the legacy single-client key
    # (GoTrue merges app_metadata top-level keys on update, so an edit must
    # blank it out rather than leave a stale value behind).
    return {"role": role, "client_ids": client_ids or None, "client_id": None}


def create_user(email: str, password: str, role: str, client_ids: list[str] | None) -> dict:
    return _request(
        "POST",
        "/admin/users",
        json={
            "email": email,
            "password": password,
            "email_confirm": True,  # closed portal: no confirmation email flow
            "app_metadata": _role_metadata(role, client_ids),
        },
    )


def set_role(user_id: str, role: str, client_ids: list[str] | None = None) -> dict:
    return update_user(user_id, app_metadata=_role_metadata(role, client_ids))
```

The rest of the file (`update_user`, `set_password`, `set_banned`, `delete_user`, `list_users`) is unchanged.

- [ ] **Step 2: Update the request models in app.py**

Replace `PortalUserCreate` (app.py lines 110-114) with:

```python
class PortalUserCreate(BaseModel):
    email: str
    role: Literal["admin", "client"] = "client"
    client_ids: list[str] = []  # one or more clients for client logins
    client_id: str | None = None  # legacy single-client field, folded into client_ids


class PortalUserUpdate(BaseModel):
    """Edit an existing login's role / client assignments."""

    role: Literal["admin", "client"]
    client_ids: list[str] = []
```

- [ ] **Step 3: Update `_user_row` and the create endpoint; add the PUT endpoint**

Replace `_user_row` (app.py lines 491-501) with:

```python
def _user_row(u: dict) -> dict:
    meta = u.get("app_metadata") or {}
    return {
        "id": u.get("id"),
        "email": u.get("email"),
        "role": meta.get("role"),
        "client_ids": allowed_client_ids(meta),
        "created_at": u.get("created_at"),
        "last_sign_in_at": u.get("last_sign_in_at"),
        "disabled": bool(u.get("banned_until")),
    }
```

Replace `create_portal_user` (app.py lines 520-535) with the helper + both endpoints:

```python
def _validated_client_ids(role: str, client_ids: list[str]) -> list[str] | None:
    """Normalised, validated client list for a login: None for admins, a
    deduped non-empty list of EXISTING client ids for client logins."""
    if role != "client":
        return None
    seen: set[str] = set()
    ids: list[str] = []
    for raw in client_ids:
        cid = (raw or "").strip()
        if cid and cid not in seen:
            seen.add(cid)
            ids.append(cid)
    if not ids:
        raise HTTPException(
            status_code=422, detail="at least one client_id is required for client logins"
        )
    for cid in ids:
        if not storage.get_client(cid):
            raise HTTPException(status_code=404, detail=f"client '{cid}' not found")
    return ids


@api.post("/admin/users")
def create_portal_user(body: PortalUserCreate):
    email = body.email.strip().lower()
    requested = list(body.client_ids)
    if body.client_id:  # legacy single-client callers
        requested.append(body.client_id)
    client_ids = _validated_client_ids(body.role, requested)
    sb = _sb()
    temp_password = sb.generate_temp_password()
    user = _sb_call(sb.create_user, email, temp_password, body.role, client_ids)
    # temp_password is returned ONCE, here, and never stored.
    return {"user": _user_row(user), "temp_password": temp_password}


@api.put("/admin/users/{user_id}")
def update_portal_user(user_id: str, body: PortalUserUpdate, user: dict = Depends(require_user)):
    if user_id == user.get("sub"):
        raise HTTPException(status_code=409, detail="You cannot edit your own account.")
    client_ids = _validated_client_ids(body.role, body.client_ids)
    return _user_row(_sb_call(_sb().set_role, user_id, body.role, client_ids))
```

- [ ] **Step 4: Verify validation paths (no real user is created — validation raises before any Supabase call)**

With the scratch AUTH_DISABLED server on :8001 (as in Task 2):

```powershell
# zero clients -> 422
curl.exe -s -X POST http://localhost:8001/api/admin/users -H "Content-Type: application/json" -d "{\"email\":\"x@y.z\",\"role\":\"client\",\"client_ids\":[]}"
# unknown client -> 404 naming it
curl.exe -s -X POST http://localhost:8001/api/admin/users -H "Content-Type: application/json" -d "{\"email\":\"x@y.z\",\"role\":\"client\",\"client_ids\":[\"nope\"]}"
# self-edit guard -> 409 (AUTH_DISABLED sub is "local-dev")
curl.exe -s -X PUT http://localhost:8001/api/admin/users/local-dev -H "Content-Type: application/json" -d "{\"role\":\"client\",\"client_ids\":[\"casinogurus\"]}"
```

Expected: 422 / 404 `client 'nope' not found` / 409 `You cannot edit your own account.`
Also run `uv run pytest tests/ -v` → still green.

- [ ] **Step 5: Commit**

```bash
git add "src/casinogurus_ai_content_engine___daily_5_topic_batch/supabase_admin.py" "src/casinogurus_ai_content_engine___daily_5_topic_batch/app.py"
git commit -m "feat(admin): multi-client login create + PUT /api/admin/users/{id} edit"
```

---

### Task 4: Frontend — thread the active business through lib/api.ts

**Files:**
- Modify: `frontend/src/lib/api.ts`

**Interfaces:**
- Produces: `setPortalClientId(id: string | null): void` — after it's set, `apiFetch` and `apiUrlWithToken` append `client_id=<id>` to every `/api/portal` path (and only those). Task 5 calls this; BatchViewer/PackageViewer/FeedbackBar/download need NO changes because they all go through these two functions.

- [ ] **Step 1: Add the portal-client hook**

In `frontend/src/lib/api.ts`, insert after the `BASE` constant:

```ts
// Active portal business for multi-client logins. Once set, every
// /api/portal request carries it as ?client_id=; the backend validates it
// against the JWT's allowed client list (forged values get a 403).
let portalClientId: string | null = null;

export function setPortalClientId(id: string | null) {
  portalClientId = id;
}

function withPortalClient(path: string): string {
  if (!portalClientId || !path.startsWith("/api/portal")) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}client_id=${encodeURIComponent(portalClientId)}`;
}
```

Then change the two request builders to use it:

```ts
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${BASE}${withPortalClient(path)}`, { ...init, headers });
}
```

```ts
export async function apiUrlWithToken(path: string): Promise<string> {
  const token = await getToken();
  const url = new URL(`${BASE}${withPortalClient(path)}`, window.location.origin);
  if (token) url.searchParams.set("access_token", token);
  return url.toString();
}
```

- [ ] **Step 2: Type-check**

Run (in `frontend/`): `npx tsc --noEmit`
Expected: no errors (same baseline as before the change).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat(frontend): portal client_id threading in the api layer"
```

---

### Task 5: Portal page — business switcher + session refresh

**Files:**
- Modify: `frontend/src/app/portal/page.tsx`

**Interfaces:**
- Consumes: `/api/portal/me` new shape `{email, clients: [...]}` (Task 2); `setPortalClientId` (Task 4).
- Produces: user-facing switcher; nothing downstream.

- [ ] **Step 1: Rework state + boot sequence**

In `frontend/src/app/portal/page.tsx`:

Update the api import:

```ts
import { apiFetch, setPortalClientId } from "@/lib/api";
```

Replace the `me` state and add the active-client state (top of the component):

```ts
const [me, setMe] = useState<{ email: string; clients: any[] } | null>(null);
const [activeClientId, setActiveClientId] = useState<string | null>(null);
```

Add the derived active client right after the state declarations:

```ts
const activeClient = me?.clients.find((c) => c.id === activeClientId) ?? null;
```

Replace the current `load` callback with a batches-only version, gated on the selection:

```ts
const load = useCallback(() => {
  if (!activeClientId) return;
  apiFetch("/api/portal/batches")
    .then((res) => res.json())
    .then((data) => {
      if (Array.isArray(data)) {
        setBatches(data);
        setSelectedBatchId((prev) => prev ?? (data.length > 0 ? data[0].id : null));
      }
      setLoading(false);
    })
    .catch(() => setLoading(false));
}, [activeClientId]);
```

Add a boot effect (replaces the `/api/portal/me` fetch that used to live in `load`) — place it before the existing `useEffect(() => { load(); ... })`:

```ts
// Boot: refresh the session once (so admin assignment edits apply on the
// next reload, not at token expiry), then load the businesses this login
// owns and restore the last-selected one.
useEffect(() => {
  const supabase = createClient();
  supabase.auth
    .refreshSession()
    .catch(() => {})
    .then(() =>
      apiFetch("/api/portal/me")
        .then((res) => res.json())
        .then((data) => {
          if (!Array.isArray(data?.clients) || data.clients.length === 0) return;
          setMe(data);
          const stored = localStorage.getItem(`portal-active-client:${data.email ?? ""}`);
          const cid = data.clients.some((c: any) => c.id === stored)
            ? (stored as string)
            : data.clients[0].id;
          setPortalClientId(cid);
          setActiveClientId(cid);
        })
        .catch(() => {})
    );
}, []);
```

Gate `checkRuns` the same way (add the guard as the first line of its body and `activeClientId` to its deps):

```ts
const checkRuns = useCallback(() => {
  if (!activeClientId) return;
  apiFetch("/api/portal/runs")
    // ... existing body unchanged ...
}, [load, activeClientId]);
```

Add the switch handler after `checkRuns`:

```ts
const switchClient = (cid: string) => {
  if (cid === activeClientId) return;
  setPortalClientId(cid);
  if (me?.email) localStorage.setItem(`portal-active-client:${me.email}`, cid);
  setActiveClientId(cid);
  setBatches([]);
  setSelectedBatchId(null);
  setLoading(true);
  setActiveRun(null);
  setProgress(null);
  setRunNotice(null);
  wasRunning.current = false;
};
```

- [ ] **Step 2: Header — switcher when the login owns several businesses**

Replace the header `<h1>`/`<p>` pair (currently `{me?.display_name ?? "Content Portal"}` and `{me?.site_domain ?? ""}`) with:

```tsx
{me && me.clients.length > 1 ? (
  <select
    value={activeClientId ?? ""}
    onChange={(e) => switchClient(e.target.value)}
    className="w-full bg-gray-800 border border-gray-700 text-gray-100 text-sm font-semibold rounded-lg p-2 outline-none focus:border-blue-500 transition-colors"
  >
    {me.clients.map((c) => (
      <option key={c.id} value={c.id}>
        {c.display_name}
      </option>
    ))}
  </select>
) : (
  <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
    {activeClient?.display_name ?? "Content Portal"}
  </h1>
)}
<p className="text-xs text-gray-500 mt-1">{activeClient?.site_domain ?? ""}</p>
```

(`portal/account/page.tsx` does not use `/api/portal/me` — no change there.)

- [ ] **Step 3: Type-check and smoke-compile**

Run (in `frontend/`): `npx tsc --noEmit`
Expected: no errors. The dev server (already running) should hot-reload without console errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/portal/page.tsx
git commit -m "feat(portal): business switcher for multi-client logins"
```

---

### Task 6: Admin users page — multi-select create + edit action

**Files:**
- Modify: `frontend/src/app/admin/users/page.tsx`

**Interfaces:**
- Consumes: `POST /api/admin/users` with `client_ids: string[]`; `PUT /api/admin/users/{id}`; user rows with `client_ids: string[]` (Task 3).

- [ ] **Step 1: State changes**

In `frontend/src/app/admin/users/page.tsx`:

Add the supabase import (to know the admin's own user id, so their row's Edit is disabled):

```ts
import { createClient } from "@/lib/supabase/client";
```

Replace `const [clientId, setClientId] = useState<string>("");` with:

```ts
const [clientIds, setClientIds] = useState<string[]>([]);
const [editing, setEditing] = useState<{
  id: string;
  email: string;
  role: "client" | "admin";
  client_ids: string[];
} | null>(null);
const [myUserId, setMyUserId] = useState<string | null>(null);
```

Add below the existing `useEffect(() => { load(); }, [load]);`:

```ts
useEffect(() => {
  createClient()
    .auth.getUser()
    .then(({ data }) => setMyUserId(data.user?.id ?? null));
}, []);
```

Add a toggle helper next to the other handlers:

```ts
const toggleClientId = (id: string, list: string[], set: (v: string[]) => void) =>
  set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
```

- [ ] **Step 2: Create form — checkbox multi-select**

In `createUser`, change the body to:

```ts
const data = await call("/api/admin/users", {
  email,
  role,
  client_ids: role === "client" ? clientIds : [],
});
```

and add `setClientIds([]);` next to `setEmail("");` after success.

Replace the single-client `<select>` block (`{role === "client" && (<div>...<select ...>...)}`) with:

```tsx
{role === "client" && (
  <div>
    <label className="mb-1 block text-xs font-medium text-gray-400">Clients (one or more)</label>
    <div className="rounded-lg border border-gray-700 bg-gray-800 p-2.5 space-y-1.5 max-h-40 overflow-y-auto">
      {clients.map((c) => (
        <label key={c.id} className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
          <input
            type="checkbox"
            checked={clientIds.includes(c.id)}
            onChange={() => toggleClientId(c.id, clientIds, setClientIds)}
            className="accent-blue-500"
          />
          {c.display_name}
        </label>
      ))}
    </div>
  </div>
)}
```

Disable submission until valid — change the submit button's `disabled` to:

```tsx
disabled={busy === "create" || (role === "client" && clientIds.length === 0)}
```

- [ ] **Step 3: Table — show all clients, add Edit**

Change the client cell from `{u.client_id ?? "—"}` to:

```tsx
<td className="px-4 py-3 text-gray-400">{(u.client_ids ?? []).join(", ") || "—"}</td>
```

Add an Edit button as the FIRST action in the actions cell (before "Reset password"):

```tsx
<button
  onClick={() =>
    setEditing({
      id: u.id,
      email: u.email,
      role: u.role === "admin" ? "admin" : "client",
      client_ids: u.client_ids ?? [],
    })
  }
  disabled={busy !== null || u.id === myUserId}
  title={u.id === myUserId ? "You cannot edit your own account" : undefined}
  className="text-xs text-gray-400 hover:text-blue-300 underline underline-offset-2 disabled:opacity-50"
>
  Edit
</button>
```

- [ ] **Step 4: Edit panel + save handler**

Add the save handler next to `createUser`:

```ts
const saveEdit = async (e: React.FormEvent) => {
  e.preventDefault();
  if (!editing) return;
  setBusy("edit");
  setError(null);
  try {
    const res = await apiFetch(`/api/admin/users/${editing.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: editing.role,
        client_ids: editing.role === "client" ? editing.client_ids : [],
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(data.detail || `Request failed (${res.status})`));
    setEditing(null);
    load();
  } catch (e: any) {
    setError(e.message);
  } finally {
    setBusy(null);
  }
};
```

Render the edit panel right after the create form block (`{showCreate && (...)}`):

```tsx
{editing && (
  <form onSubmit={saveEdit} className="mb-6 rounded-xl border border-blue-500/30 bg-gray-900/60 p-5 space-y-4">
    <div className="text-sm font-semibold text-gray-200">
      Edit {editing.email}
      <button
        type="button"
        onClick={() => setEditing(null)}
        className="float-right text-gray-400 hover:text-white transition-colors"
      >
        ✕
      </button>
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label className="mb-1 block text-xs font-medium text-gray-400">Role</label>
        <select
          value={editing.role}
          onChange={(e) => setEditing({ ...editing, role: e.target.value as "client" | "admin" })}
          className="block w-full rounded-lg border border-gray-700 bg-gray-800 p-2.5 text-sm text-gray-200 outline-none focus:border-blue-500 transition-colors"
        >
          <option value="client">Client (portal)</option>
          <option value="admin">Admin (internal team)</option>
        </select>
      </div>
      {editing.role === "client" && (
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-400">Clients (one or more)</label>
          <div className="rounded-lg border border-gray-700 bg-gray-800 p-2.5 space-y-1.5 max-h-40 overflow-y-auto">
            {clients.map((c) => (
              <label key={c.id} className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editing.client_ids.includes(c.id)}
                  onChange={() =>
                    toggleClientId(c.id, editing.client_ids, (v) => setEditing({ ...editing, client_ids: v }))
                  }
                  className="accent-blue-500"
                />
                {c.display_name}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
    <button
      type="submit"
      disabled={busy === "edit" || (editing.role === "client" && editing.client_ids.length === 0)}
      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 transition-all disabled:opacity-60"
    >
      {busy === "edit" ? "Saving…" : "Save changes"}
    </button>
    <p className="text-[11px] text-gray-500">
      Changes reach the client's portal on their next page load (their session refreshes automatically).
    </p>
  </form>
)}
```

- [ ] **Step 5: Type-check**

Run (in `frontend/`): `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/admin/users/page.tsx
git commit -m "feat(admin): multi-client login create + edit on the users page"
```

---

### Task 7: End-to-end verification (local backend + real Supabase)

**Files:** none (manual verification; both dev servers already running: backend :8000, frontend :3000 with `.env.local` → localhost:8000).

**Interfaces:** exercises everything above as a whole.

- [ ] **Step 1: Create a two-client test login**

In the browser as the admin (sahil.gholap@mastertech.co.in): `/admin/users` → Create Login → email `nexus-multitest@example.com`, role Client, tick BOTH `casinogurus` and `gemmere` → copy the temp password.
Expected: table row shows `casinogurus, gemmere`.

- [ ] **Step 2: Portal behaves per business**

In an incognito window, log in as the test user.
Expected: header shows a dropdown with both businesses; batches list matches the selected one; switching flips the list and clears the selection; Generate opens the run modal (do NOT launch a run — close it).

- [ ] **Step 3: Forged-scope security check**

Grab the test user's access token (incognito devtools → Application → Local Storage → supabase auth token, field `access_token`), then:

```powershell
curl.exe -s -H "Authorization: Bearer <TOKEN>" "http://localhost:8000/api/portal/batches?client_id=casinogurus"   # 200, allowed
curl.exe -s -o NUL -w "%{http_code}" -H "Authorization: Bearer <TOKEN>" "http://localhost:8000/api/portal/batches?client_id=some-other-client"   # 403
```

- [ ] **Step 4: Legacy login regression**

Log in as the existing Gemmere portal login (created pre-change, single `client_id` claim).
Expected: portal loads exactly as before — no switcher, Gemmere content only.

- [ ] **Step 5: Edit takes effect on reload**

As admin: Edit the test login → untick `gemmere` → Save. In the incognito session: reload the portal.
Expected: switcher is gone (single business), only casinogurus content. (The boot `refreshSession()` picks up the new claims.)

- [ ] **Step 6: Guards**

As admin on `/admin/users`: your own row's Edit button is disabled. Editing the test user to role Client with zero clients is blocked by the disabled Save button.

- [ ] **Step 7: Clean up and commit any fixes**

Delete the test login (no endpoint on purpose — one-liner):

```powershell
uv run python -c "from casinogurus_ai_content_engine___daily_5_topic_batch import supabase_admin as sb; u=[x for x in sb.list_users() if x.get('email')=='nexus-multitest@example.com']; print(sb.delete_user(u[0]['id']) if u else 'not found')"
```

If any step surfaced a bug, fix it, re-run the relevant step, and commit the fix with a `fix(...)` message.
