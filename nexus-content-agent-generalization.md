
# Generalizing NEXUS Content Agent: Multi-Client Content Platform

## Context

Currently the pipeline is built specifically for the Casino Gurus use case. The next iteration needs to decouple it from any single client and make it a generalized content engine that works for any business.

## 1. Client Onboarding (new upstream step)

Before content generation begins, each business goes through an onboarding process that establishes a client profile with:

- **Voice** — tone, style, brand personality
- **Requirements** — what the business needs from its content
- **Compliance rules** — guardrails for that client, covering all regulatory/industry constraints
- **Special instructions** — any other client-specific dos/don'ts

**Note on ownership:** Compliance rules, requirements, and special instructions are not self-reported by the client — they are defined and configured by us (the internal team) based on each client's business and regulatory context. They are still strictly client-specific: every client gets its own distinct set of guardrails, requirements, and instructions, none of which are shared or generalized across clients.

This becomes a stored client profile that the agent pipeline references on every generation run, replacing the current hardcoded Casino Gurus assumptions.

## 2. Content Type Selection

After onboarding, the user chooses the output category:

- **Long-form** (e.g., blogs)
- **Short-form** (e.g., social posts, snippets — whatever short-form types are supported)

## 3. Format Selection

Within the chosen category, the user picks the specific format — e.g., Long-form → Blog. This should be extensible so additional formats can be added under each category later without restructuring the flow.

## 4. Generation

The existing agent crew (brief specialist → drafter → voice reviewer → groundedness checker → channel adapter → human gate) runs as before, but now pulls the client's profile (voice, requirements, compliance, instructions) as context instead of a fixed configuration.

## 5. Learning Loop

The system tracks which generated pieces a business shortlists/approves over time and feeds that history back into generation — so the output for that business progressively aligns with what they've actually chosen, not just their stated preferences at onboarding.

---

## Open Questions to Pin Down Next

- Is the client profile a **structured schema** (fields the agents consume directly) or a **freeform brief** the brief specialist agent interprets?
- Does the learning loop feed back as **fine-tuning**, **few-shot examples** pulled per-run, or a **scoring signal** that adjusts the drafter/reviewer prompts?
- Do compliance rules need their **own dedicated checker agent per client** (since compliance varies by industry), or does the existing groundedness checker absorb that?
