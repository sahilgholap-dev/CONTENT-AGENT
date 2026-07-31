"""Unit tests for the topic-suggestion feature's pure helpers.

No database or Supabase needed: registry caps, prompt-directive rendering,
kickoff-input overrides, suggest-output parsing, and selection validation.
"""

from casinogurus_ai_content_engine___daily_5_topic_batch import registry


# ------------------------------- max_per_run ------------------------------ #

def test_max_per_run_blog_is_1():
    assert registry.max_per_run(registry.DEFAULT_FORMATS["blog"]) == 1


def test_max_per_run_linkedin_is_5():
    assert registry.max_per_run(registry.DEFAULT_FORMATS["linkedin_post"]) == 5


def test_max_per_run_video_uses_scripts_per_batch():
    assert registry.max_per_run(registry.DEFAULT_FORMATS["youtube_short"]) == 2


def test_max_per_run_empty_pipeline_defaults_to_1():
    spec = registry.FormatSpec(id="x", content_type="long_form", label="X", description="")
    assert registry.max_per_run(spec) == 1


from casinogurus_ai_content_engine___daily_5_topic_batch.profile import (
    _pinned_topics_directive,
    build_inputs,
    load_seed_client,
    suggestion_directive,
)


# -------------------------- _pinned_topics_directive ----------------------- #

def test_pinned_directive_empty_for_none_and_blank():
    assert _pinned_topics_directive(None) == ""
    assert _pinned_topics_directive([]) == ""
    assert _pinned_topics_directive(["  ", ""]) == ""


def test_pinned_directive_numbers_topics_and_sets_count():
    d = _pinned_topics_directive(["Topic A", "Topic B", "Topic C"])
    assert "1. Topic A" in d and "2. Topic B" in d and "3. Topic C" in d
    assert "EXACTLY the 3 topics" in d
    assert "one piece of content per topic" in d


# ---------------------------- suggestion_directive ------------------------- #

def test_suggestion_directive_empty_when_no_hint_no_avoid():
    assert suggestion_directive(None, []) == ""
    assert suggestion_directive("  ", []) == ""


def test_suggestion_directive_renders_hint_and_avoid_list():
    d = suggestion_directive("gift guide topics", ["Old Topic 1", "Old Topic 2"])
    assert 'gift guide topics' in d
    assert "- Old Topic 1" in d and "- Old Topic 2" in d
    assert "do NOT repeat" in d


# ------------------------------- build_inputs ------------------------------ #

def _seed_inputs(**kwargs):
    record = load_seed_client("casinogurus")
    spec = registry.DEFAULT_FORMATS["linkedin_post"]
    return build_inputs(
        client_name=record.display_name,
        client_site=record.site_domain,
        profile=record.profile,
        format_spec=spec,
        run_context={"revision_feedback": "x", "revision_count": "x", "escalation_reason": "x"},
        **kwargs,
    )


def test_build_inputs_defaults_for_new_keys():
    inputs = _seed_inputs()
    assert inputs["pinned_topics_directive"] == ""
    assert inputs["suggestion_directive"] == ""
    assert inputs["suggestion_count"] == 10
    assert inputs["posts_per_batch"] == 5  # linkedin default untouched


def test_build_inputs_topics_override_posts_per_batch():
    inputs = _seed_inputs(topics=["T1", "T2", "T3"])
    assert inputs["posts_per_batch"] == 3
    assert inputs["scripts_per_batch"] == 3
    assert "1. T1" in inputs["pinned_topics_directive"]
