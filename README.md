# CasinoGurus AI Content Engine

An AI-powered content generation engine built with [CrewAI](https://crewai.com) and Next.js. This system automates the daily discovery, research, and drafting of high-quality, SEO-optimized content batches tailored for CasinoGurus' US crypto-casino player audience.

## Overview

The CasinoGurus AI Content Engine employs a multi-agent system to streamline the content creation pipeline. It is specifically tuned to adhere to CasinoGurus' brand guidelines, compliance standards, and SEO best practices. 

The project consists of two main components:
1. **Python Backend (CrewAI)**: Orchestrates the AI agents, executes the content generation tasks, and stores the results in a local SQLite database. It also provides a lightweight HTTP API.
2. **Next.js Frontend**: A React-based web dashboard to view generated content batches, inspect SEO briefs, check compliance scorecards, and trigger new agent runs with real-time terminal log streaming.

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

Create a `.env` file in the root directory and add your required API keys. Note that the project utilizes Anthropic's Claude models for drafting and validation.

```bash
OPENAI_API_KEY=your_openai_api_key
ANTHROPIC_API_KEY=your_anthropic_api_key
```

### 2. Backend Setup (Python)

Navigate to the project root and sync dependencies using `uv`:

```bash
uv sync
```

Start the backend API and SQLite storage server:

```bash
uv run python -m casinogurus_ai_content_engine___daily_5_topic_batch.server
```
*The backend server will run on `http://127.0.0.1:8000`.*

### 3. Frontend Setup (Next.js)

Open a new terminal, navigate to the `frontend` directory, and install the Node modules:

```bash
cd frontend
npm install
```

Start the development server:

```bash
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
- `src/.../server.py`: The lightweight Python HTTP server exposing the SQLite DB and agent logs.
- `frontend/`: The Next.js dashboard application.
- `knowledge/`: Contains brand guidelines and user preferences injected into the agents' context.
- `content_engine.db`: The SQLite database storing all generated batches (created automatically).
