# Deployment Runbook — CasinoGurus AI Content Engine

Production stack:

| Layer | Tech | Host |
|-------|------|------|
| Frontend | Next.js 16 dashboard | **Vercel** |
| Backend API | FastAPI (`app.py`) + CrewAI | **Railway** (Docker, always-on) |
| Database | PostgreSQL (JSONB) | **Supabase** |
| Auth | Supabase Auth (email/password) | Supabase |

The steps below are the parts that need **your** accounts and secrets. All code
is already in the repo. Do them in order.

---

## 0. Prerequisites
- Accounts: [Supabase](https://supabase.com), [Railway](https://railway.app), [Vercel](https://vercel.com).
- The repo pushed to GitHub — the public **CONTENT-AGENT** repo (Railway + Vercel deploy from it).
- Local tools for the one-time data migration: `uv` and Python 3.10–3.13.

---

## 1. Supabase — database + auth

1. **Create a project.** Note the project ref (the `xxxx` in `xxxx.supabase.co`) and the database password you set.
2. **Get the connection string.** Project Settings → **Database** → **Connection Pooling** → *Transaction* mode → **URI** (host `aws-0-<region>.pooler.supabase.com`, port `6543`, user `postgres.<project-ref>`).
   - This is your `DATABASE_URL`. **Use the pooler URI, not the direct one.** The
     direct host (`db.<ref>.supabase.co:5432`) is IPv6-only and unreachable from
     Railway, which crashes the app on startup with failing health checks.
   - Percent-encode special characters in the password (`@` → `%40`, etc.).
3. **Project URL (for JWT verification).** Project Settings → **API** → **Project URL**.
   - This is your `SUPABASE_URL` (backend). The backend verifies access tokens
     against this project's JWKS endpoint, which works with the **new asymmetric
     JWT signing keys** (ES256/RS256) — no shared secret needed.
   - *Legacy only:* if your project still issues HS256 tokens, you can also set
     `SUPABASE_JWT_SECRET` (Project Settings → API → JWT Settings → *JWT Secret*).
     Optional — leave it unset once you've moved to asymmetric signing keys.
4. **Get the publishable/anon key + URL (frontend).** Project Settings → **API**.
   - `NEXT_PUBLIC_SUPABASE_URL` = *Project URL*.
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = the **publishable** key (or the legacy
     *anon public* key). Either works as the client API key in supabase-js.
5. **Create user accounts.** The app is a split portal — internal team (admin) at
   `/admin`, client logins at `/portal`. Roles live in each user's
   `app_metadata` (`{"role": "admin"}` or `{"role": "client", "client_id": "..."}`)
   and are enforced by both the frontend proxy and the API.
   - **Admins (internal team):** Authentication → **Users** → *Add user* in the
     Supabase dashboard, then grant the role by running (once per new batch of
     dashboard-created users): `uv run python scripts/grant_admin_roles.py --apply`.
   - **Client logins:** create them from the app itself — `/admin/users` →
     *Create Login* (picks the client, generates a temporary password shown
     once). Requires `SUPABASE_SERVICE_ROLE_KEY` on the backend (step 3).
   - Turn off public sign-ups (Authentication → Providers/Settings) so only
     accounts you create exist.

The app creates its own tables on first startup, so no manual SQL is required.

---

## 2. One-time data migration (local → Supabase)

Run this **once** from the repo root, on the machine that has the current
`content_engine.db`:

```bash
# point at the target Supabase DB (use the pooler URI from step 1.2)
export DATABASE_URL="postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"

uv sync                                   # installs backend deps (first run only)
uv run python scripts/migrate_sqlite_to_pg.py
```

It applies the schema, copies every batch + package + image, and prints a
summary. It is **idempotent** — safe to re-run. (Windows PowerShell: use
`$env:DATABASE_URL="..."` instead of `export`.)

To start fresh instead, just skip this step — the app creates empty tables on boot.

---

## 3. Backend — Railway

Railway builds the same `Dockerfile` (config in `railway.json`) and, unlike
Render's free tier, does not cold-sleep the service — good for multi-minute crew
runs. You can start on the trial without a card.

1. Push the repo to GitHub.
2. Railway → **New Project** → **Deploy from GitHub repo** → pick the repo.
   Railway detects the `Dockerfile` and `railway.json` automatically.
   - The container listens on Railway's injected `$PORT` (the Dockerfile handles
     this), and `/healthz` is used as the health check.
3. Set variables (Railway → the service → **Variables**):

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | the Supabase URI from step 1.2 |
   | `SUPABASE_URL` | your Project URL from step 1.3 (e.g. `https://<ref>.supabase.co`) |
   | `SUPABASE_JWT_SECRET` | *optional* — only if still using legacy HS256 tokens (step 1.3) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Project Settings → API → **service_role** key. Needed for portal user management (creating client logins). **Server-side only — never expose to the frontend.** |
   | `FRONTEND_ORIGIN` | your Vercel URL, e.g. `https://content-agent-bice.vercel.app` (add `http://localhost:3000` too, comma-separated, if you want local dev to hit prod) |
   | `ANTHROPIC_API_KEY` | your key |
   | `OPENAI_API_KEY` | your key |
   | `EXA_API_KEY` | your key |

   Do **not** set `AUTH_DISABLED` in production.
4. **Expose it:** service → **Settings** → **Networking** → **Generate Domain**.
   This gives you `https://<service>.up.railway.app`.
5. Confirm `https://<service>.up.railway.app/healthz` → `{"status":"ok"}`.
   Note this URL — the frontend needs it next.

> **Alternative — Render:** the repo also ships `render.yaml`. On Render, use
> **New + → Blueprint**, set the same variables, and pick at least the always-on
> **Starter** plan (the free tier sleeps and will kill long crew runs). The URL
> is then `https://<service>.onrender.com`.

---

## 4. Frontend — Vercel

The production frontend is deployed on Vercel from the public **CONTENT-AGENT**
GitHub repo (current URL: `https://content-agent-bice.vercel.app`). Every push
to `main` triggers an automatic redeploy.

1. Vercel → **Add New… → Project** → import the CONTENT-AGENT GitHub repo.
   - Set **Root Directory** to **`frontend`**. Vercel auto-detects Next.js;
     no build settings need changing.
2. Set the environment variables (Project → **Settings → Environment Variables**):
   - `NEXT_PUBLIC_API_URL` → the Railway URL from step 3.5
   - `NEXT_PUBLIC_SUPABASE_URL` → from step 1.4
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` → from step 1.4

   (These are public by design; real access control is the Supabase login + the
   backend JWT check.)
3. Deploy. Vercel gives you a URL (`https://<project>.vercel.app`).
4. **Back-fill CORS:** make sure that URL is in the backend's `FRONTEND_ORIGIN`
   on Railway (step 3.3). Redeploy the backend if you changed it.
   (`https://content-agent-bice.vercel.app` is also hardcoded as a safe CORS
   default in `app.py`, so the current production URL works even if the
   variable is stale.)

> **Alternative — Firebase App Hosting:** the repo also ships
> `frontend/apphosting.yaml`. Set the same three values in that file, then
> Firebase Console → **App Hosting** → connect the repo with app root
> `frontend`. The URL is then `https://<app>.web.app`.

---

## 5. Smoke test (production)

Open the Vercel URL and verify:
1. You're redirected to **/login**; signing in with a Supabase user works.
2. Existing batches load in the sidebar (from the migration); opening one shows
   the draft/compliance/SEO tabs.
3. **Download ZIP** produces a `.docx`-per-article zip.
4. **▶ Run Agent** starts a batch and the terminal streams live logs over SSE;
   a new batch appears when it finishes.
5. In a private window (logged out), hitting `https://<backend-url>/api/batches`
   directly returns **401**.

---

## Local development

**Backend:**
```bash
cp .env.example .env         # fill in DATABASE_URL, SUPABASE_JWT_SECRET, keys
uv sync
uv run uvicorn casinogurus_ai_content_engine___daily_5_topic_batch.app:app --reload --port 8000
```
Set `AUTH_DISABLED=1` in `.env` to skip token checks while developing (never in prod).

**Frontend:**
```bash
cd frontend
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:8000 + Supabase vars
npm install
npm run dev                        # http://localhost:3000
```

---

## Operational notes
- **One run at a time.** The backend refuses a second crew run while one is in
  flight (HTTP 409). Fine for a small team; if you later need concurrent or
  scheduled runs, add a Redis-backed worker (Celery/ARQ) — the code is
  structured so this is additive, not a rewrite.
- **Images** are stored in Postgres (`images` table). If the dashboard later
  renders featured images and the table grows large, move the bytes to Supabase
  Storage and keep only URLs in the DB.
- **Secrets** live only in Railway / Vercel / Supabase dashboards. `.env` is
  gitignored and excluded from the Docker image (`.dockerignore`).
