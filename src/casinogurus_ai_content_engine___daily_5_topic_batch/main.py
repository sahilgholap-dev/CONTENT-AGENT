#!/usr/bin/env python
"""Crew entry points.

Multi-client: the run is parameterised by a client profile + format instead of
a hardcoded brand constant. The API creates a ``runs`` row and passes only
``--run-id``; a bare ``run`` (local/CLI) self-provisions a run for the default
client, falling back to the committed seed profile when no database is
reachable so a local crew run always works.
"""
import os
import sys
from datetime import datetime, timezone

from casinogurus_ai_content_engine___daily_5_topic_batch.crew import CasinogurusAiContentEngineDaily5TopicBatchCrew
from casinogurus_ai_content_engine___daily_5_topic_batch import storage
from casinogurus_ai_content_engine___daily_5_topic_batch.profile import (
    ClientProfile,
    audit_yaml_placeholders,
    build_inputs,
    load_seed_client,
)
from casinogurus_ai_content_engine___daily_5_topic_batch import registry
from casinogurus_ai_content_engine___daily_5_topic_batch.storage import _PROJECT_ROOT, init_schema, save_batch

DEFAULT_CLIENT = "casinogurus"

# The revision-loop scaffolding values the pipeline has always received.
_RUN_CONTEXT = {
    "revision_feedback": "sample_value",
    "revision_count": "sample_value",
    "escalation_reason": "sample_value",
}


def _dump_raw_output(result) -> str | None:
    """Write the crew's raw output to runs/ as a safety net so a save/parse
    failure is recoverable (re-ingest with `python -m ...storage ingest <file>`)
    without re-running the crew. Never raises."""
    try:
        raw = getattr(result, "raw", None) or str(result)
        runs_dir = os.path.join(_PROJECT_ROOT, "runs")
        os.makedirs(runs_dir, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        path = os.path.join(runs_dir, f"crew_output_{stamp}.json")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(raw)
        print(f"[storage] Raw crew output saved to {path}")
        return path
    except Exception as e:
        print(f"[storage] WARNING: could not write raw output dump: {e}")
        return None


def _generate_images(batch_id):
    """Automatically generate + map a featured image to every package in the batch.

    Runs after the batch is saved. Controlled by the GENERATE_IMAGES env var
    (default on; set GENERATE_IMAGES=0 to skip). Never raises — a failure here
    must not fail the crew run; per-image errors are recorded in the DB.
    """
    if os.environ.get("GENERATE_IMAGES", "1").strip().lower() in ("0", "false", "no", "off"):
        print("[images] GENERATE_IMAGES disabled; skipping automatic image generation.")
        return
    try:
        from casinogurus_ai_content_engine___daily_5_topic_batch.images import generate_for_batch
        print("[images] Generating featured images for each content package...")
        rows = generate_for_batch(batch_id=batch_id)
        ok = sum(1 for r in rows if r and r.get("status") == "ok")
        print(f"[images] Done: {ok}/{len(rows)} images generated and mapped to packages.")
    except Exception as e:
        print(f"[images] WARNING: automatic image generation failed: {e}")


def _resolve_spec(format_id: str):
    """FormatSpec from the DB catalog, falling back to code defaults."""
    spec = storage.resolve_format_spec(format_id)
    return spec or registry.get_format(format_id)


def _seed_inputs() -> tuple[None, dict]:
    """Inputs from the committed seed profile (no database involved)."""
    record = load_seed_client(DEFAULT_CLIENT)
    spec = registry.get_format("blog")
    inputs = build_inputs(
        client_name=record.display_name,
        client_site=record.site_domain,
        profile=record.profile,
        format_spec=spec,
        run_context=dict(_RUN_CONTEXT),
    )
    return None, inputs


def _resolve_run(run_id: str | None) -> tuple[dict | None, dict]:
    """Return (run_row_or_None, kickoff_inputs).

    With --run-id: the API already created the run; load its pinned profile
    version (any failure here is fatal — the API guaranteed the data exists).
    Without: try to self-provision a run for the default client; fall back to
    the committed seed profile when the DB is unreachable.
    """
    if run_id:
        run_row = storage.get_run(run_id)
        if not run_row:
            raise SystemExit(f"[run] unknown run id: {run_id}")
        client = storage.get_client(run_row["client_id"])
        prof = storage.get_client_profile_version(run_row["client_id"], run_row["profile_version"])
        if not client or not prof:
            raise SystemExit(f"[run] client/profile missing for run {run_id}")
        profile = ClientProfile.model_validate(prof["profile"])
        spec = _resolve_spec(run_row["format"])
        inputs = build_inputs(
            client_name=client["display_name"],
            client_site=client["site_domain"],
            profile=profile,
            format_spec=spec,
            run_context=dict(_RUN_CONTEXT),
        )
        return run_row, inputs

    try:
        init_schema()
        storage.seed_registry_defaults()
        record = load_seed_client(DEFAULT_CLIENT)
        storage.upsert_client(record.client_id, record.display_name, record.site_domain)
        if storage.get_client(record.client_id)["profile_version"] == 0:
            storage.insert_profile_version(record.client_id, record.profile.model_dump(), created_by="main.run")
        run_row = storage.create_run(record.client_id, "long_form", "blog")
        print(f"[run] self-provisioned run {run_row['id']} for client '{record.client_id}'")
        return _resolve_run(run_row["id"])
    except SystemExit:
        raise
    except Exception as e:
        print(f"[run] WARNING: no database available ({e}); using committed seed profile.")
        return _seed_inputs()


def run(run_id: str | None = None):
    """Run the crew for one client/format run."""
    run_row, inputs = _resolve_run(run_id)
    audit_yaml_placeholders(inputs)

    if run_row:
        storage.update_run(run_row["id"], status="running", started_at=datetime.now(timezone.utc))

    try:
        result = CasinogurusAiContentEngineDaily5TopicBatchCrew().crew().kickoff(inputs=inputs)
    except Exception as e:
        if run_row:
            storage.update_run(
                run_row["id"], status="failed", error=str(e)[:2000], finished_at=datetime.now(timezone.utc)
            )
        raise

    # Always dump the raw output first, so a save failure never loses the run.
    _dump_raw_output(result)

    # Persist the final batch output to Postgres for the review queue / history.
    try:
        init_schema()  # no-op if the schema already exists
        if run_row:
            source = f"run:{run_row['id']}"
            batch_id = save_batch(
                result,
                source=source,
                client_id=run_row["client_id"],
                content_type=run_row["content_type"],
                format=run_row["format"],
                run_id=str(run_row["id"]),
                profile_version=run_row["profile_version"],
            )
            storage.update_run(
                run_row["id"], status="succeeded", batch_id=batch_id, finished_at=datetime.now(timezone.utc)
            )
        else:
            source = "crew_run:" + datetime.now(timezone.utc).isoformat()
            batch_id = save_batch(result, source=source, client_id=DEFAULT_CLIENT,
                                  content_type="long_form", format="blog")
        print(f"\n[storage] Saved batch to Postgres (batch id {batch_id}).")
        # Automatically generate a featured image per package and map it.
        _generate_images(batch_id)
    except Exception as e:  # never let persistence failure mask the crew result
        if run_row:
            try:
                storage.update_run(
                    run_row["id"],
                    status="failed",
                    error=f"crew succeeded but save failed: {e}"[:2000],
                    finished_at=datetime.now(timezone.utc),
                )
            except Exception:
                pass
        print(f"\n[storage] WARNING: could not save batch to Postgres: {e}")
        print("[storage] The raw output was dumped to runs/; re-ingest it with:")
        print("[storage]   python -m casinogurus_ai_content_engine___daily_5_topic_batch.storage ingest <file>")

    return result


def _offline_inputs() -> dict:
    """Seed-profile inputs for train/test (no DB, no run row)."""
    return _seed_inputs()[1]


def train():
    """Train the crew for a given number of iterations."""
    try:
        CasinogurusAiContentEngineDaily5TopicBatchCrew().crew().train(
            n_iterations=int(sys.argv[1]), filename=sys.argv[2], inputs=_offline_inputs()
        )
    except Exception as e:
        raise Exception(f"An error occurred while training the crew: {e}")


def replay():
    """Replay the crew execution from a specific task."""
    try:
        CasinogurusAiContentEngineDaily5TopicBatchCrew().crew().replay(task_id=sys.argv[1])
    except Exception as e:
        raise Exception(f"An error occurred while replaying the crew: {e}")


def test():
    """Test the crew execution and returns the results."""
    try:
        CasinogurusAiContentEngineDaily5TopicBatchCrew().crew().test(
            n_iterations=int(sys.argv[1]), openai_model_name=sys.argv[2], inputs=_offline_inputs()
        )
    except Exception as e:
        raise Exception(f"An error occurred while testing the crew: {e}")


def run_with_trigger():
    """Legacy console-script alias (kept for pyproject entry points)."""
    return run()


def _parse_run_id(argv: list[str]) -> str | None:
    if "--run-id" in argv:
        i = argv.index("--run-id")
        if i + 1 < len(argv):
            return argv[i + 1]
        raise SystemExit("--run-id requires a value")
    return None


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: main.py <command> [--run-id <uuid>] [<args>]")
        sys.exit(1)

    command = sys.argv[1]
    if command == "run":
        run(run_id=_parse_run_id(sys.argv[2:]))
    elif command == "train":
        sys.argv = sys.argv[1:]
        train()
    elif command == "replay":
        sys.argv = sys.argv[1:]
        replay()
    elif command == "test":
        sys.argv = sys.argv[1:]
        test()
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)
