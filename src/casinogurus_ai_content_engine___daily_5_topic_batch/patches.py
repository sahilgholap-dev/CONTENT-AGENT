"""Runtime patches for third-party libraries. Call apply() once at startup.

FIX 1 (Anthropic + CrewAI max-iteration fallback):
CrewAI's ``handle_max_iterations_exceeded`` appends its "give your final answer
now" message with role="assistant" and then calls the model. Anthropic's newer
models (Claude Sonnet 5, Claude Haiku 4.5) reject a conversation that ends on an
assistant turn:

    400 invalid_request_error: This model does not support assistant message
    prefill. The conversation must end with a user message.

So the moment ANY agent hits ``max_iter``, that 400 fires from the
``ensure_force_final_answer`` listener and the run dies. We swap in an identical
implementation that appends the forced message as role="user" instead.

FIX 2 (Anthropic + CrewAI output_pydantic converter fallback):
When a task has ``output_pydantic`` and the agent's final answer is not directly
parseable JSON (unescaped quote, trailing prose, truncation), CrewAI's
``Converter.to_pydantic`` re-asks the LLM with ``response_model=<model>``.
Against current Anthropic structured outputs our Batch schema (free-form dicts,
``extra="allow"``) is rejected outright:

    400 invalid_request_error: Schema is too complex.

...so the "safety net" itself throws and the whole (paid) run dies at the final
step — this killed a live Gemmere blog run. We wrap ``to_pydantic`` with a
deterministic salvage pass first (JSON span extraction + json_repair, both
already available) and only fall back to the LLM converter when that fails.
"""

from __future__ import annotations

import json
import re

from crewai.utilities import agent_utils as _au


def _handle_max_iterations_exceeded(
    formatted_answer,
    printer,
    messages,
    llm,
    callbacks,
    verbose: bool = True,
):
    """Drop-in replacement for crewai's handler; forced message uses role='user'."""
    if verbose:
        printer.print(
            content="Maximum iterations reached. Requesting final answer.",
            color="yellow",
        )

    if formatted_answer and hasattr(formatted_answer, "text"):
        forced = formatted_answer.text + f"\n{_au.I18N_DEFAULT.errors('force_final_answer')}"
    else:
        forced = _au.I18N_DEFAULT.errors("force_final_answer")

    # The ONLY change vs. upstream: role="user" (was "assistant") so Anthropic
    # models accept the trailing turn.
    messages.append(_au.format_message_for_llm(forced, role="user"))

    answer = llm.call(messages, callbacks=callbacks)

    if answer is None or answer == "":
        raise ValueError("Invalid response from LLM call - None or empty.")

    formatted = _au.format_answer(answer=answer)
    if isinstance(formatted, _au.AgentFinish):
        return formatted
    return _au.AgentFinish(
        thought=formatted.thought,
        output=formatted.text,
        text=formatted.text,
    )


_JSON_SPAN_RE = re.compile(r"\{.*\}", re.DOTALL)


def _salvage_json_text(text: str):
    """Deterministically recover a JSON object from LLM output.

    Tries, in order: plain json.loads; json.loads on the outermost {...} span
    (strips markdown fences / surrounding prose); json_repair on that span
    (fixes unescaped quotes, trailing commas, truncated tails). Returns a dict
    or None — never raises.
    """
    candidates = [text]
    m = _JSON_SPAN_RE.search(text or "")
    if m and m.group(0) != text:
        candidates.append(m.group(0))
    for cand in candidates:
        try:
            doc = json.loads(cand)
            if isinstance(doc, dict):
                return doc
        except Exception:
            pass
    try:
        import json_repair

        doc = json_repair.loads((m.group(0) if m else text) or "")
        if isinstance(doc, dict) and doc:
            return doc
    except Exception:
        pass
    return None


def _patch_converter() -> None:
    from crewai.utilities import converter as _cv

    original_to_pydantic = _cv.Converter.to_pydantic

    def to_pydantic(self, current_attempt: int = 1):
        doc = _salvage_json_text(getattr(self, "text", "") or "")
        if doc is not None:
            try:
                return self.model.model_validate(doc)
            except Exception:
                pass  # salvaged JSON doesn't fit the model -> let the LLM try
        return original_to_pydantic(self, current_attempt)

    _cv.Converter.to_pydantic = to_pydantic


_applied = False


def apply() -> None:
    """Install the patches (idempotent)."""
    global _applied
    if _applied:
        return

    # FIX 1 — patch the definition site.
    _au.handle_max_iterations_exceeded = _handle_max_iterations_exceeded

    # The experimental executor imported the symbol by value, so patch that
    # module's reference too (that is the code path the error came from).
    try:
        from crewai.experimental import agent_executor as _ex

        _ex.handle_max_iterations_exceeded = _handle_max_iterations_exceeded
    except Exception:
        pass

    # FIX 2 — deterministic JSON salvage before the LLM converter.
    try:
        _patch_converter()
    except Exception:
        pass  # never let a patch failure block runs; worst case = old behavior

    _applied = True
