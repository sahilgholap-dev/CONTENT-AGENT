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
