import os


from crewai import LLM
from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task
from crewai_tools import (
    ExaSearchTool,
    ScrapeWebsiteTool,
)


# Model policy (cost vs. context):
#   * Agents that call web tools (Exa search / website scraping) pull large,
#     unbounded web text into context and overflow Haiku 4.5's 200K window, so
#     they run on Sonnet 5 (1M context): topic discovery, research/grounding.
#   * The drafter runs on Sonnet 5 for draft quality (it also ingests the full
#     research context).
#   * The tool-less gate agents (compliance, SEO) and the crew manager only see
#     the finished draft (small), so they stay on cheap Haiku 4.5.
_SONNET = "anthropic/claude-sonnet-5"
_HAIKU = "anthropic/claude-haiku-4-5"


@CrewBase
class CasinogurusAiContentEngineDaily5TopicBatchCrew:
    """CasinogurusAiContentEngineDaily5TopicBatch crew"""

    @agent
    def casino_seo_research_grounding_specialist(self) -> Agent:
        return Agent(
            config=self.agents_config["casino_seo_research_grounding_specialist"],
            tools=[ExaSearchTool(), ScrapeWebsiteTool()],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # Web tools (Exa + scrape) -> large context -> needs 1M window.
            llm=LLM(model=_SONNET),
        )

    @agent
    def casinogurus_grounded_article_drafter(self) -> Agent:
        return Agent(
            config=self.agents_config["casinogurus_grounded_article_drafter"],
            tools=[],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # Sonnet 5 for draft quality + large research context.
            llm=LLM(model=_SONNET),
        )

    @agent
    def casino_content_compliance_mandate_checker(self) -> Agent:
        return Agent(
            config=self.agents_config["casino_content_compliance_mandate_checker"],
            tools=[],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # No tools; only sees the draft -> cheap Haiku is fine.
            llm=LLM(model=_HAIKU),
        )

    @agent
    def casino_content_seo_quality_checker(self) -> Agent:
        return Agent(
            config=self.agents_config["casino_content_seo_quality_checker"],
            tools=[],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # No tools; only sees the draft -> cheap Haiku is fine.
            llm=LLM(model=_HAIKU),
        )

    @agent
    def casino_content_topic_discovery_specialist(self) -> Agent:
        return Agent(
            config=self.agents_config["casino_content_topic_discovery_specialist"],
            tools=[ExaSearchTool()],
            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=8,
            max_rpm=None,
            max_execution_time=None,
            # Web search (Exa) -> large context -> needs 1M window.
            llm=LLM(model=_SONNET),
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
            chat_llm=LLM(model=_HAIKU),
        )
