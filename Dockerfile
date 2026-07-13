# Backend container for the CasinoGurus Content Engine API (FastAPI on Render).
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

# Build tooling for any deps without prebuilt wheels (psycopg[binary] ships its own).
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir uv

# Install dependencies first for better layer caching.
COPY pyproject.toml uv.lock README.md ./
COPY src ./src
RUN uv sync --no-dev

# App source + runtime assets (knowledge base, config, etc.).
COPY . .

EXPOSE 8000

# Render injects $PORT; default to 8000 for local `docker run`.
CMD ["sh", "-c", "uv run uvicorn casinogurus_ai_content_engine___daily_5_topic_batch.app:app --host 0.0.0.0 --port ${PORT:-8000}"]
