"""Runtime patches for third-party libraries. Call apply() once at startup.

FIX (Anthropic + CrewAI max-iteration fallback):
CrewAI's ``handle_max_iterations_exceeded`` appends its "give your final answer
now" message with role="assistant" and then calls the model. Anthropic's newer
models (Claude Sonnet 5, Claude Haiku 4.5) reject a conversation that ends on an
assistant turn:

    400 invalid_request_error: This model does not support assistant message
    prefill. The conversation must end with a user message.

So the moment ANY agent hits ``max_iter``, that 400 fires from the
``ensure_force_final_answer`` listener and the run dies. We swap in an identical
implementation that appends the forced message as role="user" instead.
"""

from __future__ import annotations

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


_applied = False


def apply() -> None:
    """Install the patches (idempotent)."""
    global _applied
    if _applied:
        return

    # Patch the definition site.
    _au.handle_max_iterations_exceeded = _handle_max_iterations_exceeded

    # The experimental executor imported the symbol by value, so patch that
    # module's reference too (that is the code path the error came from).
    try:
        from crewai.experimental import agent_executor as _ex

        _ex.handle_max_iterations_exceeded = _handle_max_iterations_exceeded
    except Exception:
        pass

    _applied = True
