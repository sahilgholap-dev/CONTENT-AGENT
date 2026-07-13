# CasinoGurus AI Content Engine

An AI-powered content generation engine built with [CrewAI](https://crewai.com) and Next.js. This system automates the daily discovery, research, and drafting of high-quality, SEO-optimized content batches tailored for CasinoGurus' US crypto-casino player audience.

## Overview

The CasinoGurus AI Content Engine employs a multi-agent system to streamline the content creation pipeline. It is specifically tuned to adhere to CasinoGurus' brand guidelines, compliance standards, and SEO best practices. 

The project consists of two main components:
1. **Python Backend (FastAPI + CrewAI)**: A FastAPI service (`app.py`) that orchestrates the AI agents, persists results to PostgreSQL, and exposes a JSON API protected by Supabase Auth.
2. **Next.js Frontend**: A React-based web dashboard to view generated content batches, inspect SEO briefs, check compliance scorecards, and trigger new agent runs with real-time terminal log streaming.

> **Deploying to production?** See **[DEPLOYMENT.md](./DEPLOYMENT.md)** for the full runbook (Supabase + Render + Firebase App Hosting). The steps below are for local development.

## Features

- **Automated Topic Discovery**: Identifies high-value, player-intent-driven topics for the US crypto-casino market.
- **Multi-Agent Collaboration**: Utilizes specialized agents (Topic Discovery Specialist, Keyword Researcher, Grounded Drafter, and SEO/Compliance Gatekeeper) working in sequence.
- **Strict Guardrails & Compliance**: Enforces hard word-count floors, checks for disallowed punctuation, verifies claims against a built-in fact store, and ensures affiliate/age disclosures are present.
- **Web Dashboard**: View generated drafts, metadata, and validation flags in a clean UI.
- **Real-Time Agent Execution**: Start a new daily batch directly from the dashboard and watch the terminal logs stream in real-time via Server-Sent Events (SSE).

## Installation & Setup

### Prerequisites
- Node.js (v18+)
- Python (>=3.10 <3.14)
- [UV](https://docs.astral.sh/uv/) for Python dependency management

### 1. Environment Configuration

Copy `.env.example` to `.env` in the project root and fill in the values. You need a PostgreSQL database (a free [Supabase](https://supabase.com) project works well) and the Supabase JWT secret, plus the LLM/tool keys:

```bash
cp .env.example .env
# DATABASE_URL, SUPABASE_JWT_SECRET, ANTHROPIC_API_KEY, OPENAI_API_KEY, EXA_API_KEY
```

For local development you can set `AUTH_DISABLED=1` in `.env` to bypass token checks (never do this in production).

### 2. Backend Setup (FastAPI)

From the project root, sync dependencies and start the API:

```bash
uv sync
uv run uvicorn casinogurus_ai_content_engine___daily_5_topic_batch.app:app --reload --port 8000
```
*The backend runs on `http://127.0.0.1:8000`. It creates the database schema automatically on startup. Health check: `GET /healthz`.*

### 3. Frontend Setup (Next.js)

Open a new terminal, go to `frontend`, configure env, and start the dev server:

```bash
cd frontend
cp .env.local.example .env.local
# set NEXT_PUBLIC_API_URL=http://localhost:8000 and the Supabase vars
npm install
npm run dev
```
*The frontend dashboard will be available at `http://localhost:3000`.*

## Usage

1. Open the dashboard at `http://localhost:3000`.
2. Browse previous content batches to review drafts, compliance scorecards, and SEO briefs.
3. Click the **▶ Run Agent** button in the sidebar to kick off a new batch generation. A terminal window will appear displaying the live execution logs of the CrewAI agents.

## Project Structure

- `src/.../config/`: Contains `agents.yaml` and `tasks.yaml` defining the CrewAI pipeline.
- `src/.../main.py`: Entry point for the CrewAI execution.
- `src/.../app.py`: The FastAPI service exposing the JSON API, agent-run trigger, and SSE log stream (Supabase-Auth protected).
- `src/.../db.py` / `storage.py` / `schema.sql`: PostgreSQL connection pool, persistence layer, and schema.
- `src/.../auth.py`: Supabase JWT verification.
- `scripts/migrate_sqlite_to_pg.py`: One-time migration of an old `content_engine.db` into Postgres.
- `frontend/`: The Next.js dashboard application (Supabase Auth; `proxy.ts` guards routes).
- `knowledge/`: Contains brand guidelines and user preferences injected into the agents' context.
- `Dockerfile` / `render.yaml`: Backend container + Render deployment blueprint.
