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
