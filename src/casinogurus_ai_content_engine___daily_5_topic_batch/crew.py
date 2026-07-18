import os


from crewai import LLM
from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task

from casinogurus_ai_content_engine___daily_5_topic_batch.tools.custom_tool import (
    BoundedExaSearchTool,
    BoundedScrapeWebsiteTool,
)
from casinogurus_ai_content_engine___daily_5_topic_batch.models import Batch
from casinogurus_ai_content_engine___daily_5_topic_batch import patches as _patches

# Fixes CrewAI's max-iteration fallback so it doesn't send an assistant-terminated
# conversation (which Anthropic models 400 on). Must run before any crew kickoff.
_patches.apply()


# Model policy (cost-first, one quality exception):
#   * Almost every agent runs on Haiku 4.5. It is far cheaper than Sonnet 5 and its
#     200K context window is enough as long as web-tool output is bounded.
#   * The web-tool agents (topic discovery + research/grounding) previously ran on
#     Sonnet 5 (1M) only because raw Exa/scrape output overflowed 200K. We now cap
#     that output with BoundedExaSearchTool / BoundedScrapeWebsiteTool (see
#     tools/custom_tool.py), so their context stays under Haiku's 200K window.
#     Trade-off: slightly thinner research (less scraped text) for much lower cost.
#   * EXCEPTION: the drafter runs on Sonnet 5 for draft quality. It has NO tools, so
#     it only ingests the bounded research JSON and stays in the cheap <=200K price
#     tier (not the 200K-1M tier that made the web agents expensive before).
#   * The tool-less gate agents (compliance, SEO) and the crew manager only see the
#     finished draft (small), so Haiku was always fine there.
_HAIKU = "anthropic/claude-haiku-4-5"
_SONNET = "anthropic/claude-sonnet-5"

# CrewAI defaults an LLM's max output to 4096 tokens. A full article-draft JSON
# (a 1,200-1,500 word body_html plus every other field) and the assemble task's
# package JSON both exceed that, so the output was being TRUNCATED after body_html
# (dropping seo_title/meta_description/slug/featured_image_prompt) and the batch
# failed to save. Both models allow far more output (Haiku 4.5 up to 64K); 16K is
# ample headroom for our largest output and we only pay for tokens actually made.
_MAX_TOKENS = 16000


def _haiku_llm(max_tokens: int = _MAX_TOKENS) -> LLM:
    return LLM(model=_HAIKU, max_tokens=max_tokens)


def _sonnet_llm(max_tokens: int = _MAX_TOKENS) -> LLM:
    return LLM(model=_SONNET, max_tokens=max_tokens)


# These agents run unattended in a batch pipeline. Haiku will otherwise sometimes
# stop and ask the user a question (e.g. "which option do you prefer?") instead of
# producing its required output, which yields prose with no JSON and nothing to
# save. This directive, appended to every agent's backstory, forbids that.
_PIPELINE_DIRECTIVE = (
    "\n\nOPERATING MODE (critical): You run inside a fully automated pipeline with "
    "NO human available to answer questions. Always return your complete output in "
    "the exact format the task specifies. NEVER ask a question, request "
    "clarification, or present options to choose from, and NEVER stop to wait for "
    "input. If any required input is missing, incomplete, or fails a check, follow "
    "the task's documented fallback path and still return the full output. Output "
    "only the specified format, with no commentary before or after it."
)


def _cfg(config: dict) -> dict:
    """Return a copy of an agent config with the pipeline directive appended to its
    backstory (so all agents get the no-questions / always-output rule)."""
    merged = dict(config)
    merged["backstory"] = (merged.get("backstory", "") or "") + _PIPELINE_DIRECTIVE
    return merged


def _log_task_progress(output) -> None:
    """Emit the progress marker the dashboard's terminal counts. Keeping the
    emitter in-repo (instead of relying on ambient CrewAI logging) means the
    '[AGENT_PROGRESS] Task Completed' contract is ours to maintain."""
    try:
        name = getattr(output, "name", None) or ""
        print(f"[AGENT_PROGRESS] Task Completed: {name}".rstrip(": "), flush=True)
    except Exception:
        print("[AGENT_PROGRESS] Task Completed", flush=True)


def _make_agent(config: dict, tools: list, llm: LLM) -> Agent:
    """Shared agent construction (same knobs for every agent in every crew)."""
    return Agent(
        config=_cfg(config),
        tools=tools,
        reasoning=False,
        max_reasoning_attempts=None,
        inject_date=True,
        allow_delegation=False,
        max_iter=8,
        max_rpm=None,
        max_execution_time=None,
        llm=llm,
    )


@CrewBase
class CasinogurusAiContentEngineDaily5TopicBatchCrew:
    """CasinogurusAiContentEngineDaily5TopicBatch crew"""

    @agent
    def casino_seo_research_grounding_specialist(self) -> Agent:
        return Agent(
            config=_cfg(self.agents_config["casino_seo_research_grounding_specialist"]),
            tools=[BoundedExaSearchTool(), BoundedScrapeWebsiteTool()],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # Bounded web tools keep context under Haiku's 200K window.
            llm=_haiku_llm(),
        )

    @agent
    def casinogurus_grounded_article_drafter(self) -> Agent:
        return Agent(
            config=_cfg(self.agents_config["casinogurus_grounded_article_drafter"]),
            tools=[],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # Sonnet 5 for draft quality. No tools -> only the bounded research JSON
            # in context, so it stays in the cheap <=200K price tier.
            # 32K output cap (vs the default 16K): Sonnet 5 runs adaptive thinking
            # by default and max_tokens caps thinking + answer COMBINED. On a heavy
            # client profile (first Gemmere blog run) the model spent most of 16K
            # thinking and the article JSON was cut off ~600 tokens in, leaving
            # seo_title/meta_description/slug/featured_image_prompt empty. Social
            # and video drafters were already raised to 32K for the same reason.
            llm=_sonnet_llm(max_tokens=32000),
        )

    @agent
    def casino_content_compliance_mandate_checker(self) -> Agent:
        return Agent(
            config=_cfg(self.agents_config["casino_content_compliance_mandate_checker"]),
            tools=[],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # No tools; only sees the draft -> cheap Haiku is fine.
            llm=_haiku_llm(),
        )

    @agent
    def casino_content_seo_quality_checker(self) -> Agent:
        return Agent(
            config=_cfg(self.agents_config["casino_content_seo_quality_checker"]),
            tools=[],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # No tools; only sees the draft -> cheap Haiku is fine.
            llm=_haiku_llm(),
        )

    @agent
    def casino_content_topic_discovery_specialist(self) -> Agent:
        return Agent(
            config=_cfg(self.agents_config["casino_content_topic_discovery_specialist"]),
            tools=[BoundedExaSearchTool()],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # Bounded Exa search keeps context under Haiku's 200K window.
            llm=_haiku_llm(),
        )

    @task
    def discover_daily_casino_topics(self) -> Task:
        return Task(
            config=self.tasks_config["discover_daily_casino_topics"],
            markdown=False,
        )

    @task
    def keyword_research_and_competitor_analysis(self) -> Task:
        return Task(
            config=self.tasks_config["keyword_research_and_competitor_analysis"],
            markdown=False,
        )

    @task
    def draft_casino_article(self) -> Task:
        return Task(
            config=self.tasks_config["draft_casino_article"],
            markdown=False,
        )

    @task
    def compliance_gate_check(self) -> Task:
        return Task(
            config=self.tasks_config["compliance_gate_check"],
            markdown=False,
        )

    @task
    def seo_and_quality_gate_check(self) -> Task:
        return Task(
            config=self.tasks_config["seo_and_quality_gate_check"],
            markdown=False,
        )

    @task
    def assemble_draft_package_for_review_queue(self) -> Task:
        return Task(
            config=self.tasks_config["assemble_draft_package_for_review_queue"],
            markdown=False,
            # Force the saved output through a validated schema. CrewAI coerces the
            # agent's answer into Batch via tool-calling, so the final JSON is always
            # valid even when body_html contains unescaped-looking HTML quotes.
            output_pydantic=Batch,
        )

    @crew
    def crew(self) -> Crew:
        """Creates the CasinogurusAiContentEngineDaily5TopicBatch crew"""

        return Crew(
            agents=self.agents,  # Automatically created by the @agent decorator
            tasks=self.tasks,  # Automatically created by the @task decorator
            process=Process.sequential,
            # verbose prints every tool's full output (including entire scraped
            # web pages) to stdout — that floods the host's log pipeline
            # (Railway caps at 500 lines/sec) and bloats context. Keep it off.
            verbose=False,
            # Manager/chat is tool-less -> cheap Haiku.
            chat_llm=_haiku_llm(),
            # Dashboard progress marker per completed task (see TerminalLogs).
            task_callback=_log_task_progress,
        )


@CrewBase
class SocialPostCrew:
    """Short-form social-post crew (task_variant: social_post).

    Five tasks from config/tasks_social.yaml, reusing the same agent
    definitions (and therefore the same client-profile placeholders) as the
    blog crew. Platform specifics (char limits, hashtags, tone) arrive via the
    {format_directives} input rendered from the selected format's pipeline
    params, so ONE variant serves Instagram, LinkedIn, Facebook, etc.
    """

    tasks_config = "config/tasks_social.yaml"

    @agent
    def casino_content_topic_discovery_specialist(self) -> Agent:
        # Bounded Exa search keeps context under Haiku's 200K window.
        return _make_agent(
            self.agents_config["casino_content_topic_discovery_specialist"],
            [BoundedExaSearchTool()],
            _haiku_llm(),
        )

    @agent
    def casino_seo_research_grounding_specialist(self) -> Agent:
        return _make_agent(
            self.agents_config["casino_seo_research_grounding_specialist"],
            [BoundedExaSearchTool(), BoundedScrapeWebsiteTool()],
            _haiku_llm(),
        )

    @agent
    def casinogurus_grounded_article_drafter(self) -> Agent:
        # Sonnet for drafting quality; tool-less so context stays small.
        # 32K output cap (vs the default 16K): one drafting call emits ALL
        # {posts_per_batch} post objects in a single JSON array, and the first
        # live Instagram run truncated post 5 mid-hashtag at 16K.
        return _make_agent(
            self.agents_config["casinogurus_grounded_article_drafter"],
            [],
            _sonnet_llm(max_tokens=32000),
        )

    @agent
    def casino_content_compliance_mandate_checker(self) -> Agent:
        return _make_agent(
            self.agents_config["casino_content_compliance_mandate_checker"],
            [],
            _haiku_llm(),
        )

    @task
    def discover_social_topics(self) -> Task:
        return Task(config=self.tasks_config["discover_social_topics"], markdown=False)

    @task
    def social_research_grounding(self) -> Task:
        return Task(config=self.tasks_config["social_research_grounding"], markdown=False)

    @task
    def draft_social_posts(self) -> Task:
        return Task(config=self.tasks_config["draft_social_posts"], markdown=False)

    @task
    def social_compliance_gate(self) -> Task:
        return Task(config=self.tasks_config["social_compliance_gate"], markdown=False)

    @task
    def assemble_social_package(self) -> Task:
        return Task(
            config=self.tasks_config["assemble_social_package"],
            markdown=False,
            # Same validated batch contract as the blog crew, so storage /
            # viewer / DOCX export work unchanged.
            output_pydantic=Batch,
        )

    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=False,
            chat_llm=_haiku_llm(),
            task_callback=_log_task_progress,
        )


@CrewBase
class VideoScriptCrew:
    """Video-script crew (task_variant: video_script).

    Five tasks from config/tasks_video.yaml, reusing the same agent
    definitions (and therefore the same client-profile placeholders) as the
    blog/social crews. Duration window, orientation, scene granularity and
    tone arrive via the {format_directives} input rendered from the selected
    format's pipeline params, so ONE variant serves short vertical videos
    (Shorts/Reels) and long chaptered YouTube videos alike.
    """

    tasks_config = "config/tasks_video.yaml"

    @agent
    def casino_content_topic_discovery_specialist(self) -> Agent:
        # Bounded Exa search keeps context under Haiku's 200K window.
        return _make_agent(
            self.agents_config["casino_content_topic_discovery_specialist"],
            [BoundedExaSearchTool()],
            _haiku_llm(),
        )

    @agent
    def casino_seo_research_grounding_specialist(self) -> Agent:
        # 32K output cap: this agent also runs assemble_video_package, whose
        # output carries every script's scenes verbatim PLUS the body_html
        # rendering — for two long-format scripts that exceeds 16K, and the
        # first live youtube_long run responded by silently dropping the
        # scenes arrays from the final packages.
        return _make_agent(
            self.agents_config["casino_seo_research_grounding_specialist"],
            [BoundedExaSearchTool(), BoundedScrapeWebsiteTool()],
            _haiku_llm(max_tokens=32000),
        )

    @agent
    def casinogurus_grounded_article_drafter(self) -> Agent:
        # Sonnet for drafting quality; tool-less so context stays small.
        # 32K output cap: one drafting call emits ALL {scripts_per_batch}
        # script objects (a long-format script is ~1,300-1,500 spoken words
        # plus per-scene JSON overhead), which does not fit the default 16K.
        return _make_agent(
            self.agents_config["casinogurus_grounded_article_drafter"],
            [],
            _sonnet_llm(max_tokens=32000),
        )

    @agent
    def casino_content_compliance_mandate_checker(self) -> Agent:
        return _make_agent(
            self.agents_config["casino_content_compliance_mandate_checker"],
            [],
            _haiku_llm(),
        )

    @task
    def discover_video_topics(self) -> Task:
        return Task(config=self.tasks_config["discover_video_topics"], markdown=False)

    @task
    def video_research_grounding(self) -> Task:
        return Task(config=self.tasks_config["video_research_grounding"], markdown=False)

    @task
    def draft_video_scripts(self) -> Task:
        return Task(config=self.tasks_config["draft_video_scripts"], markdown=False)

    @task
    def video_compliance_gate(self) -> Task:
        return Task(config=self.tasks_config["video_compliance_gate"], markdown=False)

    @task
    def assemble_video_package(self) -> Task:
        return Task(
            config=self.tasks_config["assemble_video_package"],
            markdown=False,
            # Same validated batch contract as the blog crew, so storage /
            # viewer / DOCX export work unchanged.
            output_pydantic=Batch,
        )

    @crew
    def crew(self) -> Crew:
        return Crew(
            agents=self.agents,
            tasks=self.tasks,
            process=Process.sequential,
            verbose=False,
            chat_llm=_haiku_llm(),
            task_callback=_log_task_progress,
        )


# task_variant -> crew class. main.py selects the crew per run.
CREW_BY_VARIANT = {
    "default": CasinogurusAiContentEngineDaily5TopicBatchCrew,
    "social_post": SocialPostCrew,
    "video_script": VideoScriptCrew,
}
