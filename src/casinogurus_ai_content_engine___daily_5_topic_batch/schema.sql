-- PostgreSQL schema for the CasinoGurus content store (Supabase).
-- Ported from the original SQLite schema in storage.py. Design is unchanged:
-- every queryable field is its own column, and the full nested objects
-- (draft / compliance_scorecard / seo_quality_scorecard / whole batch) are ALSO
-- stored verbatim as JSONB so the database stays a lossless record of every run.
--
-- Applied idempotently on startup (see db.py::init_schema). All statements use
-- IF NOT EXISTS so re-running is safe.

CREATE TABLE IF NOT EXISTS batches (
    id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    batch_date             TEXT,
    total_packages         INTEGER,
    ready_for_review_count INTEGER,
    needs_review_count     INTEGER,
    source                 TEXT,             -- file path or "crew_run:<ts>"
    ingested_at            TIMESTAMPTZ NOT NULL,
    raw_json               JSONB NOT NULL    -- full batch object, verbatim
);

CREATE TABLE IF NOT EXISTS packages (
    package_id                 TEXT PRIMARY KEY,
    batch_id                   BIGINT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
    topic                      TEXT,
    primary_keyword            TEXT,
    pillar                     TEXT,
    created_at                 TEXT,
    revision_count             INTEGER,
    review_status              TEXT,
    escalation_reason          TEXT,
    reviewer_notes             TEXT,
    -- flattened draft fields (queryable); full draft kept in draft_json
    seo_title                  TEXT,
    meta_description           TEXT,
    slug                       TEXT,
    category                   TEXT,
    excerpt                    TEXT,
    featured_image_prompt      TEXT,
    responsible_gambling_note  TEXT,
    body_html                  TEXT,
    -- scorecard summaries (queryable); full scorecards kept as JSONB
    compliance_verdict         TEXT,
    seo_verdict                TEXT,
    seo_overall_score          REAL,
    -- lossless nested objects
    draft_json                 JSONB,
    compliance_json            JSONB,
    seo_json                   JSONB
);

CREATE TABLE IF NOT EXISTS source_notes (
    id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    package_id       TEXT NOT NULL REFERENCES packages(package_id) ON DELETE CASCADE,
    claim            TEXT,
    fact_store_entry TEXT,
    source_url       TEXT,
    confidence       TEXT
);

CREATE TABLE IF NOT EXISTS verification_flags (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    package_id        TEXT NOT NULL REFERENCES packages(package_id) ON DELETE CASCADE,
    flag              TEXT,
    location_in_draft TEXT
);

CREATE TABLE IF NOT EXISTS images (
    package_id  TEXT PRIMARY KEY REFERENCES packages(package_id) ON DELETE CASCADE,
    prompt      TEXT,          -- the generation prompt actually sent (alt stripped)
    alt_text    TEXT,          -- alt='...' parsed out of featured_image_prompt
    image_b64   TEXT,          -- base64-encoded image bytes (no data: prefix)
    mime_type   TEXT,          -- e.g. image/png
    model       TEXT,          -- generation model used
    size        TEXT,          -- e.g. 1024x1024
    status      TEXT,          -- 'ok' | 'error'
    error       TEXT,          -- error message when status = 'error'
    created_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_packages_batch    ON packages(batch_id);
CREATE INDEX IF NOT EXISTS idx_packages_pillar   ON packages(pillar);
CREATE INDEX IF NOT EXISTS idx_packages_status   ON packages(review_status);
CREATE INDEX IF NOT EXISTS idx_batches_date      ON batches(batch_date);
CREATE INDEX IF NOT EXISTS idx_srcnotes_package  ON source_notes(package_id);
CREATE INDEX IF NOT EXISTS idx_flags_package     ON verification_flags(package_id);

-- ---------------------------------------------------------------------------
-- Multi-client (NEXUS) tables. All idempotent. NOTE: db.py::_split_statements
-- naively splits this file on semicolons and strips comment lines, so never
-- put a semicolon or a double-dash inside a string literal here. Large profile
-- documents are seeded by scripts/seed_client.py, never from this file.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS clients (
    id           TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    site_domain  TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only profile versions. Active profile = MAX(version) per client.
-- A run pins the version it launched with, so edits never touch in-flight runs.
CREATE TABLE IF NOT EXISTS client_profiles (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id  TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    version    INTEGER NOT NULL,
    profile    JSONB NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (client_id, version)
);
CREATE INDEX IF NOT EXISTS idx_profiles_client ON client_profiles(client_id, version DESC);

-- One row per agent run. The API inserts it (status queued) and passes only
-- --run-id to the subprocess. This is also the job record a future LangGraph
-- worker consumes. No FK on batch_id: save_batch re-ingest deletes batch rows.
CREATE TABLE IF NOT EXISTS runs (
    id              UUID PRIMARY KEY,
    client_id       TEXT NOT NULL REFERENCES clients(id),
    profile_version INTEGER NOT NULL,
    content_type    TEXT NOT NULL DEFAULT 'long_form',
    format          TEXT NOT NULL DEFAULT 'blog',
    status          TEXT NOT NULL DEFAULT 'queued',
    error           TEXT,
    batch_id        BIGINT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_runs_client ON runs(client_id, created_at DESC);

-- Optional user-provided topic: when set, the discovery task structures this
-- exact topic instead of discovering one (rendered via {topic_directive}).
ALTER TABLE runs ADD COLUMN IF NOT EXISTS topic TEXT;

-- Append-only reviewer feedback events (shortlisted | approved | rejected).
-- The learning loop distils from this log. Latest event per package = current status.
CREATE TABLE IF NOT EXISTS package_reviews (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    package_id TEXT NOT NULL REFERENCES packages(package_id) ON DELETE CASCADE,
    client_id  TEXT NOT NULL,
    action     TEXT NOT NULL,
    feedback   TEXT,
    reviewer   TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_client  ON package_reviews(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_package ON package_reviews(package_id, created_at DESC);

-- Additive client/run columns on existing tables (FK-less by design: Postgres
-- has no ADD CONSTRAINT IF NOT EXISTS and this file must stay idempotent).
ALTER TABLE batches  ADD COLUMN IF NOT EXISTS client_id       TEXT;
ALTER TABLE batches  ADD COLUMN IF NOT EXISTS content_type    TEXT;
ALTER TABLE batches  ADD COLUMN IF NOT EXISTS format          TEXT;
ALTER TABLE batches  ADD COLUMN IF NOT EXISTS run_id          UUID;
ALTER TABLE batches  ADD COLUMN IF NOT EXISTS profile_version INTEGER;
ALTER TABLE packages ADD COLUMN IF NOT EXISTS client_id       TEXT;

CREATE INDEX IF NOT EXISTS idx_batches_client         ON batches(client_id);
CREATE INDEX IF NOT EXISTS idx_packages_client_status ON packages(client_id, review_status);

-- Learning loop: LLM-distilled learned_style proposals, human-gated. A distill
-- run reads package_reviews past the last watermark, proposes an updated
-- learned_style, and parks it here. Accepting writes a new profile version via
-- insert_profile_version; the profile itself is never touched automatically.
CREATE TABLE IF NOT EXISTS learning_proposals (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_id      TEXT NOT NULL,
    proposed_text  TEXT NOT NULL,
    current_text   TEXT NOT NULL DEFAULT '',   -- learned_style at distill time
    last_review_id BIGINT NOT NULL,            -- watermark: max package_reviews.id analysed
    review_count   INTEGER NOT NULL DEFAULT 0, -- events analysed in this run
    status         TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | dismissed | superseded
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at     TIMESTAMPTZ,
    decided_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_learning_client ON learning_proposals(client_id, created_at DESC);

-- Content-type / format catalog (the "master"). Rows are seeded from the code
-- defaults (registry.py) at startup when empty, then managed via the API. The
-- pipeline behaviour of a format is chosen by its task_variant (code); all
-- other fields (labels, description, enabled, word counts, stage labels) are
-- editable data.
CREATE TABLE IF NOT EXISTS content_types (
    id         TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS formats (
    id           TEXT PRIMARY KEY,
    content_type TEXT NOT NULL REFERENCES content_types(id) ON DELETE CASCADE,
    label        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    enabled      BOOLEAN NOT NULL DEFAULT true,
    task_variant TEXT NOT NULL DEFAULT 'default',
    pipeline     JSONB NOT NULL DEFAULT '{}'::jsonb,
    stage_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_formats_content_type ON formats(content_type);

-- Seed the first client and backfill legacy rows (no-ops after first boot).
INSERT INTO clients (id, display_name, site_domain)
VALUES ('casinogurus', 'CasinoGurus', 'casinogurus.org')
ON CONFLICT (id) DO NOTHING;

UPDATE batches
SET client_id = 'casinogurus', content_type = 'long_form', format = 'blog'
WHERE client_id IS NULL;

UPDATE packages p
SET client_id = b.client_id
FROM batches b
WHERE p.batch_id = b.id AND p.client_id IS NULL;
