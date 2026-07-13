# Deployment Runbook — CasinoGurus AI Content Engine

Production stack:

| Layer | Tech | Host |
|-------|------|------|
| Frontend | Next.js 16 dashboard | **Firebase App Hosting** |
| Backend API | FastAPI (`app.py`) + CrewAI | **Railway** (Docker, always-on) |
| Database | PostgreSQL (JSONB) | **Supabase** |
| Auth | Supabase Auth (email/password) | Supabase |

The steps below are the parts that need **your** accounts and secrets. All code
is already in the repo. Do them in order.

---

## 0. Prerequisites
- Accounts: [Supabase](https://supabase.com), [Railway](https://railway.app), [Firebase](https://console.firebase.google.com).
- The repo pushed to GitHub (Railway + Firebase deploy from it).
- Local tools for the one-time data migration: `uv` and Python 3.10–3.13.

---

## 1. Supabase — database + auth

1. **Create a project.** Note the project ref (the `xxxx` in `xxxx.supabase.co`) and the database password you set.
2. **Get the connection string.** Project Settings → **Database** → *Connection string* → **URI**. Use the direct `:5432` URI for the migration; either that or the `:6543` transaction-pooler URI works for the running app.
   - This is your `DATABASE_URL`.
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
5. **Create user accounts.** Authentication → **Users** → *Add user* (one per team member, with email + password). Optionally turn off public sign-ups (Authentication → Providers/Settings) so only invited users exist.

The app creates its own tables on first startup, so no manual SQL is required.

---

## 2. One-time data migration (local → Supabase)

Run this **once** from the repo root, on the machine that has the current
`content_engine.db`:

```bash
# point at the target Supabase DB (direct :5432 URI recommended for the migration)
export DATABASE_URL="postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres"

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
   | `FRONTEND_ORIGIN` | your Firebase URL, e.g. `https://<app>.web.app` (add `http://localhost:3000` too, comma-separated, if you want local dev to hit prod) |
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

## 4. Frontend — Firebase App Hosting

1. Edit **`frontend/apphosting.yaml`** and set the three values:
   - `NEXT_PUBLIC_API_URL` → the Railway URL from step 3.5
   - `NEXT_PUBLIC_SUPABASE_URL` → from step 1.4
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` → from step 1.4

   (These are public by design; real access control is the Supabase login + the
   backend JWT check.)
2. Firebase Console → **App Hosting** → **Get started** → connect the GitHub repo,
   set the app root to **`frontend`**, and pick the branch to deploy.
3. Deploy. Firebase builds with `apphosting.yaml` and gives you a URL
   (`https://<app>.web.app`).
4. **Back-fill CORS:** make sure that URL is in the backend's `FRONTEND_ORIGIN`
   on Railway (step 3.3). Redeploy the backend if you changed it.

---

## 5. Smoke test (production)

Open the Firebase URL and verify:
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
- **Secrets** live only in Railway / Firebase / Supabase dashboards. `.env` is
  gitignored and excluded from the Docker image (`.dockerignore`).
