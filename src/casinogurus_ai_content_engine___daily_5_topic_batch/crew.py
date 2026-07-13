import os


from crewai import LLM
from crewai import Agent, Crew, Process, Task
from crewai.project import CrewBase, agent, crew, task
from crewai_tools import (
	ExaSearchTool,
	ScrapeWebsiteTool
)






@CrewBase
class CasinogurusAiContentEngineDaily5TopicBatchCrew:
    """CasinogurusAiContentEngineDaily5TopicBatch crew"""

    
    @agent
    def casino_seo_research_grounding_specialist(self) -> Agent:
        
        
        return Agent(
            config=self.agents_config["casino_seo_research_grounding_specialist"],


            tools=[				ExaSearchTool(),
				ScrapeWebsiteTool()],

            reasoning=False,
            max_reasoning_attempts=None,
            inject_date=True,
            allow_delegation=False,
            max_iter=25,
            max_rpm=None,


            max_execution_time=None,
            llm=LLM(
                model="anthropic/claude-sonnet-5",
                is_litellm=True,

            ),
            
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
            max_iter=25,
            max_rpm=None,


            max_execution_time=None,
            llm=LLM(
                model="anthropic/claude-sonnet-5",
                is_litellm=True,

            ),
            
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
            max_iter=25,
            max_rpm=None,


            max_execution_time=None,
            llm=LLM(
                model="anthropic/claude-haiku-4-5",
                is_litellm=True,

            ),
            
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
            max_iter=25,
            max_rpm=None,


            max_execution_time=None,
            llm=LLM(
                model="anthropic/claude-haiku-4-5",
                is_litellm=True,

            ),
            
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
            max_iter=25,
            max_rpm=None,
            
            
            max_execution_time=None,
            llm=LLM(
                model="anthropic/claude-sonnet-5",
                is_litellm=True,

            ),
            
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
            verbose=True,

            chat_llm=LLM(model="anthropic/claude-haiku-4-5", is_litellm=True),
        )


