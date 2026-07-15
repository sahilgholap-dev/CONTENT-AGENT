import os


from crewai import LLM
from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task

from casinogurus_ai_content_engine___daily_5_topic_batch.tools.custom_tool import (
    BoundedExaSearchTool,
    BoundedScrapeWebsiteTool,
)
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


def _haiku_llm() -> LLM:
    return LLM(model=_HAIKU, max_tokens=_MAX_TOKENS)


def _sonnet_llm() -> LLM:
    return LLM(model=_SONNET, max_tokens=_MAX_TOKENS)


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
            llm=_sonnet_llm(),
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
        )
