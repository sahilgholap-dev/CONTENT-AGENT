#!/usr/bin/env python
import os
import sys
from datetime import datetime, timezone

from casinogurus_ai_content_engine___daily_5_topic_batch.crew import CasinogurusAiContentEngineDaily5TopicBatchCrew
from casinogurus_ai_content_engine___daily_5_topic_batch.storage import save_batch


# ---------------------------------------------------------------------------
# CasinoGurus brand / voice context (brief Section 1).
# This is interpolated into the tasks as {voice_store}. Edit here to update
# the brand identity the agents write for. Deliberately contains no em-dashes
# or en-dashes (see brief Section 8.4).
# ---------------------------------------------------------------------------
CASINOGURUS_VOICE = """
WHO WE ARE:
- Site: casinogurus.org, a WordPress affiliate casino-review site. Note the .org domain. Do NOT confuse with casinoguru.com or casinogurus.com, which belong to a different, much larger company. Their content is never ours.
- Business model: we earn affiliate commission when a reader signs up at a casino through our /go/ redirect links.
- Current situation: recovering from a Google penalty (December 2025 core update targeting low-trust YMYL/gambling content). The recovery strategy is to focus on one lane and build trust, not to publish more scattered content.

THE ONE LANE (every topic must serve this):
CasinoGurus is the trusted place for crypto / Bitcoin casino reviews for a US audience.

PRIMARY AUDIENCE:
US-based players choosing where to gamble with crypto. The US is the only audience with real commercial value for this site.

VOICE:
Expert, clear, plain-language, safety-first, non-hype. Never sensationalist. Always includes responsible-gambling framing. Writes like a real person who has actually tested the casinos, not like an encyclopedia or a compliance manual.

WHAT CASINOGURUS IS NOT (treat these as out of scope):
- Not a general iGaming site covering poker, sports betting, or slots-in-general.
- Not a trade or industry news publication. No "market", "operators", or "regulatory regime" topics.
- Not a B2B or operator-facing site.
- Not focused on any country other than the US.
""".strip()


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

# This main file is intended to be a way for your to run your
# crew locally, so refrain from adding unnecessary logic into this file.
# Replace with inputs you want to test with, it will automatically
# interpolate any tasks and agents information

def run():
    """
    Run the crew.
    """
    inputs = {
        'voice_store': CASINOGURUS_VOICE,
        'revision_feedback': 'sample_value',
        'revision_count': 'sample_value',
        'escalation_reason': 'sample_value'
    }
    result = CasinogurusAiContentEngineDaily5TopicBatchCrew().crew().kickoff(inputs=inputs)

    # Persist the final batch output to SQLite for the review queue / history.
    try:
        source = "crew_run:" + datetime.now(timezone.utc).isoformat()
        batch_id = save_batch(result, source=source)
        print(f"\n[storage] Saved batch to SQLite (batch id {batch_id}).")
        # Automatically generate a featured image per package and map it.
        _generate_images(batch_id)
    except Exception as e:  # never let persistence failure mask the crew result
        print(f"\n[storage] WARNING: could not save batch to SQLite: {e}")

    return result


def train():
    """
    Train the crew for a given number of iterations.
    """
    inputs = {
        'voice_store': CASINOGURUS_VOICE,
        'revision_feedback': 'sample_value',
        'revision_count': 'sample_value',
        'escalation_reason': 'sample_value'
    }
    try:
        CasinogurusAiContentEngineDaily5TopicBatchCrew().crew().train(n_iterations=int(sys.argv[1]), filename=sys.argv[2], inputs=inputs)

    except Exception as e:
        raise Exception(f"An error occurred while training the crew: {e}")

def replay():
    """
    Replay the crew execution from a specific task.
    """
    try:
        CasinogurusAiContentEngineDaily5TopicBatchCrew().crew().replay(task_id=sys.argv[1])

    except Exception as e:
        raise Exception(f"An error occurred while replaying the crew: {e}")

def test():
    """
    Test the crew execution and returns the results.
    """
    inputs = {
        'voice_store': CASINOGURUS_VOICE,
        'revision_feedback': 'sample_value',
        'revision_count': 'sample_value',
        'escalation_reason': 'sample_value'
    }
    try:
        CasinogurusAiContentEngineDaily5TopicBatchCrew().crew().test(n_iterations=int(sys.argv[1]), openai_model_name=sys.argv[2], inputs=inputs)

    except Exception as e:
        raise Exception(f"An error occurred while testing the crew: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: main.py <command> [<args>]")
        sys.exit(1)

    command = sys.argv[1]
    if command == "run":
        run()
    elif command == "train":
        train()
    elif command == "replay":
        replay()
    elif command == "test":
        test()
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)
