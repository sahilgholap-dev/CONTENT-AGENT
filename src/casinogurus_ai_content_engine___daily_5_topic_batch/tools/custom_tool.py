from typing import Any, Type

from crewai.tools import BaseTool
from crewai_tools import ExaSearchTool, ScrapeWebsiteTool
from pydantic import BaseModel, Field


# --------------------------------------------------------------------------- #
# Context-bounded web tools
# --------------------------------------------------------------------------- #
# The web-tool agents (topic discovery + research/grounding) run on Haiku 4.5,
# whose context window is 200K tokens. Raw ScrapeWebsiteTool returns the FULL
# text of a page, and those results accumulate across the agent's reasoning
# loop (re-sent every iteration), which is exactly what used to overflow 200K
# and force the expensive Sonnet 1M path.
#
# These subclasses cap each tool result to a fixed CHARACTER budget so the
# accumulated context stays small (and cheap). Roughly 4 chars/token, so:
#   * scrape  12,000 chars  ~= 3,000 tokens per page
#   * exa      8,000 chars  ~= 2,000 tokens per search
# Even a full max_iter loop of tool calls then stays well under 200K tokens.
# Tune these two numbers to trade research depth against cost.
_SCRAPE_CHAR_LIMIT = 12000
_EXA_CHAR_LIMIT = 8000

_TRUNCATION_NOTE = (
    "\n\n[TRUNCATED to fit the model context budget. If you need more detail, "
    "refine your query or scrape a more specific page instead of a large index page.]"
)


def _truncate(result: Any, limit: int) -> Any:
    """Cap a tool result to `limit` characters (stringifying non-str results)."""
    if result is None:
        return result
    text = result if isinstance(result, str) else str(result)
    if len(text) > limit:
        return text[:limit] + _TRUNCATION_NOTE
    return text


class BoundedScrapeWebsiteTool(ScrapeWebsiteTool):
    """ScrapeWebsiteTool that caps scraped page text so it cannot overflow the
    200K-token Haiku context window."""

    char_limit: int = _SCRAPE_CHAR_LIMIT

    def _run(self, **kwargs: Any) -> Any:
        return _truncate(super()._run(**kwargs), self.char_limit)


class BoundedExaSearchTool(ExaSearchTool):
    """ExaSearchTool that caps its (stringified) search output for the same reason.

    Exa already defaults to content=False + highlights=True (compact snippets),
    so this is mostly a safety net against unusually large highlight sets."""

    char_limit: int = _EXA_CHAR_LIMIT

    def _run(self, *args: Any, **kwargs: Any) -> Any:
        return _truncate(super()._run(*args, **kwargs), self.char_limit)


# --------------------------------------------------------------------------- #
# Scaffold example tool (kept from the CrewAI template; unused).
# --------------------------------------------------------------------------- #
class MyCustomToolInput(BaseModel):
    """Input schema for MyCustomTool."""
    argument: str = Field(..., description="Description of the argument.")

class MyCustomTool(BaseTool):
    name: str = "Name of my tool"
    description: str = (
        "Clear description for what this tool is useful for, your agent will need this information to use it."
    )
    args_schema: Type[BaseModel] = MyCustomToolInput

    def _run(self, argument: str) -> str:
        return "this is an example of a tool output, ignore it and move along."
