# Multi-client portal logins + editable login assignments

**Date:** 2026-07-31
**Status:** Approved by Sahil (design review in session)

## Problem

A portal login is created with exactly one `client_id` baked into Supabase
`app_metadata`, and nothing about a login can be changed after creation
(only password reset and enable/disable). A person who owns multiple
businesses (e.g. mairaj.poke@gmail.com) cannot use one login to view and
generate content for all of them, and an admin cannot fix an assignment
mistake without deleting and recreating the login.

Client *profile* editing is out of scope — it already exists on
`/admin/clients` (`ClientProfileForm` → `PUT /api/clients/{id}`, append-only
profile versions).

## Decisions (made with user)

1. **Scope:** editable login assignments on `/admin/users` (role + assigned
   clients), plus multi-client logins. No changes to client-record editing.
2. **Portal UX:** a business switcher dropdown; all portal views scope to the
   selected business.
3. **Storage:** JWT claims array in `app_metadata` (no DB migration), not a
   join table. Accepted trade-off: assignment edits reach the client on their
   next token refresh; mitigated by a forced session refresh on portal load.

## Design

### 1. Data model (Supabase app_metadata only)

New claim shape:

```json
{"role": "client", "client_ids": ["gemmere", "casinogurus"]}
```

Legacy shape `{"role": "client", "client_id": "gemmere"}` remains valid:
auth derives the allowed list as `client_ids` if present, else
`[client_id]`. Any edit through the new endpoint rewrites the metadata to
the new shape. Admin logins ignore client lists entirely.

### 2. Backend auth (`auth.py`)

- `require_client` resolves `portal_client_ids: list[str]` from the claims.
  A client login with an empty list gets 403 ("not linked to a client"),
  matching current behaviour. Admins get `portal_client_ids = None`
  (unrestricted; must name a client explicitly).
- `_portal_cid(user, client_id)` (app.py) becomes:
  - client, param given → param must be in `portal_client_ids`, else 403
    (no information leak about which clients exist);
  - client, no param → if exactly one allowed client, use it; if several,
    422 asking for `client_id`;
  - admin → unchanged: explicit `?client_id=` required (422 otherwise).
- All portal endpoints (`me`, `batches`, `batches/{id}[/download]`,
  `packages/{pid}/image|feedback`, `formats`, `run-agent`, `run-progress`,
  `runs`) already resolve scope via `_portal_cid`, so they inherit the new
  rules without per-endpoint changes.

### 3. Admin user-management API (`app.py`, `supabase_admin.py`)

- `supabase_admin.create_user` / `set_role` take `client_ids: list[str] | None`
  and write the new claim shape.
- `_user_row` returns `client_ids` (normalised from either claim shape).
- `POST /api/admin/users`: body takes `client_ids: string[]`; each id must
  exist in the clients table; ≥1 required when role is `client`; ignored
  (stored as `None`) for admins.
- **New** `PUT /api/admin/users/{user_id}`: body `{role, client_ids}` with
  the same validation; writes app_metadata via the Supabase Admin API.
  Guards: editing your own account is 409 (prevents self-demotion lockout,
  same spirit as the self-disable guard).

### 4. Portal API + frontend (business switcher)

- `GET /api/portal/me` returns
  `{email, clients: [{id, display_name, site_domain, status}, ...]}` — one
  entry per assigned business (admins with `?client_id=` get that one).
- Portal page holds `activeClientId` in state, persisted to `localStorage`
  (keyed by user id), defaulting to the first assigned client. A dropdown
  in the portal header switches it; hidden when only one business.
- Every portal fetch passes `?client_id=<activeClientId>`; switching client
  resets batch selection, run polling, and notices.
- On portal load, call `supabase.auth.refreshSession()` once so a fresh JWT
  (with any new assignments) is used — admin edits take effect on the
  client's next page load instead of token expiry (~1h).

### 5. Admin users frontend (`/admin/users`)

- Create form: the single client `<select>` becomes a checkbox multi-select
  of clients (required ≥1 when role is client).
- Table: "Client" column lists all assigned client ids; each row gains an
  **Edit** action opening a small editor (role select + client checkboxes)
  that calls `PUT /api/admin/users/{id}`. Own account's Edit is disabled.

### 6. Error handling

- Client requesting a `client_id` outside their list → 403, generic message.
- `client` role with zero clients → 422 at create/edit time; 403 at auth
  time if such a token exists anyway.
- Unknown client id in `client_ids` → 404 naming the bad id (admin-only
  surface, no leak concern).
- Legacy single-`client_id` logins keep working untouched until edited.

### 7. Testing

Local end-to-end (backend :8000, frontend :3000):

1. Create a login assigned two clients → temp password shown once.
2. Log in as it: switcher shows both businesses; batches/runs/Generate all
   scope to the selected one; switching flips the lists.
3. Forged `?client_id=` for an unassigned client on every portal endpoint
   → 403, no data.
4. Existing single-client login (Gemmere) works unchanged.
5. Edit assignments (add/remove a client) → client reloads portal → new
   assignment visible (session refresh path).
6. Self-edit and self-disable guards return 409.
