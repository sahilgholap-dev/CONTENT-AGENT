# CasinoGurus Content Agent — CrewAI → LangGraph Migration Prompt

> **How to use this file.** Open this repo in Claude Code (Opus 4.8 or Fable) and paste the prompt below as your first instruction. The repo already contains the CrewAI build you are migrating, the two authoritative design docs (`NEXUS_Agent_Services_PRD_v3.docx` and `CasinoGurus_Content_Agent_LangGraph_Build_Prompt.md`), a working SQLite persistence layer, an image pipeline, an HTTP server, and a browser viewer. **You are migrating the orchestration only. You are not rewriting the prompts, the database, the image pipeline, the server, or the viewer.**

---

## PROMPT — paste everything below into Claude Code

You are migrating an existing, working CrewAI content-generation pipeline to LangGraph. This is an **orchestration migration**, not a rewrite. The hardest and most valuable work — the four agent prompts, the compliance/SEO gate logic, the anti-fabrication rules, the SQLite persistence layer, the image pipeline, the HTTP server, and the browser viewer — is **already done and must be preserved**. Your job is to replace the CrewAI sequential runner with a LangGraph graph that adds the control flow CrewAI could not express: a bounded revision loop, conditional gate routing, durable checkpointed state, a clean human-gate seam, and the outer continuous loop.

### Step 0 — Read before writing anything

Do these in order. Do not write code until all are done.

1. **Verify library versions before writing any LangGraph code.** Fetch `https://pypi.org/pypi/langgraph/json` and `https://pypi.org/pypi/langchain-anthropic/json` for the latest versions, and read the current LangGraph docs for `StateGraph`, `add_conditional_edges`, reducers (`Annotated` + operator), checkpointers (`InMemorySaver`, `langgraph-checkpoint-sqlite`/`PostgresSaver`), and `interrupt_before`. Your training data is likely stale on LangGraph's API — the live docs win. Report the versions you found before proceeding.
2. **Read the two design documents in the repo** as the authoritative source of truth: `CasinoGurus_Content_Agent_LangGraph_Build_Prompt.md` (the target inner-graph/outer-loop design) and `NEXUS_Agent_Services_PRD_v3.docx` (governance doctrine). Where this prompt and those documents conflict, follow the documents and flag the conflict to me.
3. **Read the existing CrewAI source** so you know exactly what you are porting:
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/config/agents.yaml` — the 5 agent role/goal/backstory definitions.
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/config/tasks.yaml` — the 6 task descriptions containing ALL the hard-won rule logic (compliance pre-check, anti-fabrication, verbatim-H2, completeness guard, gate verdicts).
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/crew.py` — agent wiring, models, tools.
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/main.py` — the current entry point and how it calls storage + images.
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/storage.py` — the SQLite schema and `save_batch()` contract. **Study the exact batch/package JSON shape it expects.**
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/images.py` and `server.py` — the downstream consumers of the DB.
   - `Sample_Output.json` — the canonical batch output shape your graph MUST reproduce.

### The single most important constraint: preserve the output contract

The existing `storage.py`, `images.py`, `server.py`, and `package-viewer.html` all depend on one exact JSON shape — the batch envelope emitted by the final task. **Your LangGraph build must emit byte-compatible batch JSON so that `save_batch()`, the image pipeline, the server, and the viewer all keep working unchanged.** This is the contract; treat `Sample_Output.json` as the golden fixture. The batch object is:

```
{
  "batch_date": "YYYY-MM-DD",
  "total_packages": int,
  "ready_for_review_count": int,
  "needs_review_count": int,
  "packages": [ <package>, ... ]   // exactly 5
}
```

Each `<package>` has these keys, exactly (from `Sample_Output.json`):
`package_id, topic, primary_keyword, pillar, created_at, revision_count, review_status, escalation_reason, draft, compliance_scorecard, seo_quality_scorecard, verification_flags, reviewer_notes`

- `draft` keys: `body_html, seo_title, meta_description, slug, category, tags, excerpt, featured_image_prompt, responsible_gambling_note, internal_links, source_notes, verification_flags`
- `compliance_scorecard` keys: `overall_verdict, checks, blocking_failures, revision_instructions`
- `seo_quality_scorecard` keys: `overall_verdict, overall_score, dimensions, revision_instructions`

Do not rename, drop, or restructure any of these. If you add fields, add them additively and never remove existing ones. After the build, prove the contract holds by running `save_batch()` on your graph's output into a throwaway DB and confirming `server.py` serves it and the viewer renders it.

### What to build

Build a `langgraph/` package alongside the existing CrewAI source (do **not** delete the CrewAI code — leave it in place as reference and fallback until the port is validated). Use **Python + LangGraph**, with LLM calls via `langchain-anthropic`. Live web search is the research/discovery tool.

**Phase 1 is the priority. Do Phase 1 completely, validate it, then stop and report before starting Phase 2.**

#### Inner graph (per-topic, bounded)

Define a `ContentState` TypedDict carrying at least: `topic`, `seo_brief`, `fact_store`, `voice_profile`, `draft`, `compliance_result`, `seo_result`, `revision_count`, `verification_flags`, `status`, plus whatever fan-in reducer fields you need. For fields written concurrently by the two parallel gates, use `Annotated[...]` with an explicit reducer so concurrent writes merge instead of clobbering — confirm the correct reducer pattern against the live LangGraph docs.

Nodes:

- **`research`** — keyword research + competitor analysis via web search; outputs the SEO brief and a source-tagged fact store. Summarizes competitor structure/gaps only; never copies competitor prose. Port the prompt logic from the `keyword_research_and_competitor_analysis` task in `tasks.yaml`.
- **`draft`** — writes the article strictly from `seo_brief` + `fact_store`, in the voice from `voice_profile`. Asserts only facts present in `fact_store`; anything unsourced (bonus figures, licensing, payout speed, legality) becomes an explicit `verification_flags` entry, never a guess. Port ALL rules from the `draft_casino_article` task verbatim in intent: the mandatory affiliate/age/RG boilerplate, the banned-phrase self-scan, the verbatim primary-keyword-in-H2 rule, the anti-fabrication rule (no invented casino names or per-operator figures; the three fallback options for the comparison table), the FAQ-before-Conclusion ordering, and the verification-flag rule.
- **`compliance_gate`** and **`seo_gate`** — two **parallel** nodes (fan out from `draft`, fan in before the router). Port the full check logic from the `compliance_gate_check` and `seo_and_quality_gate_check` tasks, including: the bonus-accuracy pre-check that copies the complete sentence verbatim and PASSES automatically when `[VERIFICATION_FLAG` is present; year-freshness as informational-only (never in `blocking_failures`, never affects verdict); and the six SEO dimensions.
- **`gate_router`** — a conditional edge after both gates fan in:
  - both pass → `queue_handoff`
  - either fails AND `revision_count < MAX_REVISIONS` → increment `revision_count`, route back to `draft` carrying the specific failing items as revision feedback
  - either fails AND `revision_count == MAX_REVISIONS` → `queue_handoff` with `status = "needs_heavier_review"`
- **`queue_handoff`** — assembles the Draft Package (draft + brief + fact store + both scorecards + flags), computes `review_status`, and produces the package JSON. **Terminal node of the inner graph.** Port the assembler logic from `assemble_draft_package_for_review_queue`: the completeness pre-check (non-truncated `body_html` ending in a Conclusion with BeGambleAware.org; non-empty `seo_title`/`meta_description`/`slug`; `featured_image_prompt` includes `alt=`) and the fabrication scan, both run before `review_status` is set.

**Human-gate seam:** compile the inner graph with `interrupt_before` positioned so the eventual human review slots in cleanly, and note in the README exactly where a real reviewer replaces the queue write. For this build the "human" is the DB write; leave the seam clean and documented. This satisfies the PRD's hard rule that nothing ships without human approval — the gate must be a graph-topology guarantee, not a prompt instruction.

#### Non-negotiable constraints — enforce in graph topology and state, NOT in model reasoning

- `MAX_REVISIONS = 2`, checked in `gate_router` as an integer comparison. Never let a model decide when to stop revising.
- Both gates must pass; combine their results at the fan-in via the state reducer.
- Terminal action is the queue write / package assembly. **No publishing. No WordPress tool. Ever.**
- Caps and thresholds are named constants (`MAX_REVISIONS = 2`, `DAILY_DRAFT_CAP = 5`, a queue-depth pause value), not magic numbers.
- `voice_profile` holds tone/style only (no facts); `fact_store` holds sourced facts only (no style). Two distinct state fields. The drafter takes wording from voice, claims from fact.

#### Fix these two known defects during the port (do not carry them over)

1. **SEO gating false-negative.** The CrewAI assembler forces `needs_heavier_review` if *any single* SEO dimension fails, which contradicts the project's own principle of keying review-readiness off structural blocking signals rather than string verdicts. In the LangGraph build, gate `review_status` on compliance `blocking_failures[]` being empty plus the SEO `overall_verdict`, and treat low-severity SEO dimension misses as non-blocking (surface them in `revision_instructions`/`reviewer_notes`, don't block on them). Give SEO dimensions a severity or blocking concept if needed. Document the change.
2. **Undefined SEO `overall_score`.** The SEO scorecard declares `overall_score` but never specifies how to compute it. Define it explicitly as the **average** of the six dimension scores (not the sum), rounded to one decimal. This matches the `Sample_Output.json` values (e.g. six 8–9s → 8.8).

#### Model configuration — implement the hybrid from the start, but phase the swap

The design doc specifies one model for all nodes. The project's own validated finding is that the drafter benefits from a stronger model than the checkers. Implement **per-node model selection** (each node picks its own model via a small config map) so the hybrid is trivial to set. **But do the migration in two phases so accuracy changes are never confounded with the framework change:**

- **Phase 1 — port on equivalent models.** Wire every node to the same OpenAI models the CrewAI build currently uses (drafter/checkers/assembler on `gpt-4.1`, discovery on its current model) via `langchain-openai` if needed, so you can diff the LangGraph output against the CrewAI baseline on the same topics. The goal of Phase 1 is: *the framework changed, the output did not.* Confirm the batch JSON contract holds and the viewer renders it.
- **Phase 2 — swap models with validation (only after Phase 1 passes).** Move to the per-node hybrid (a stronger drafter model; capable checker/assembler models) using `langchain-anthropic` per the design doc. Then re-run the project's known failure cases and confirm no regression: (a) the phantom-compliance-violation case (a weaker model hallucinating violations that don't exist), and (b) the fabricate-then-flag loophole (a model inventing named-casino rows to satisfy a flagging rule). Re-tune the literal, rule-bound prompt bits against the new model if they drift — specifically the verbatim-copy-before-FAIL compliance pre-check, the exact-phrase banned-word self-scan, and the "`[VERIFICATION_FLAG` present → PASS" logic. Keep the drafter model choice deliberate: validate a stronger drafter against Golden samples rather than assuming.

#### Outer loop (Phase 2)

A control layer around the compiled inner graph — a plain Python loop or a second simple LangGraph graph, your call, but keep the two levels clearly separate. Each cycle:

1. Check the pacing gate: stop if `DAILY_DRAFT_CAP` (5) reached today, or the review queue is over its safety cap; else idle to next day.
2. Discover candidate keywords (port the `discover_daily_casino_topics` logic).
3. Select the next topic: exclude duplicates (worked-topics ledger) and hard compliance-risk topics → rank by the seven-dimension keyword score → apply pillar-coverage bias (reviews / bonuses / crypto / guides / regional) → pick the top eligible.
4. Invoke the inner graph once for that topic.
5. Persist and repeat.

**State to persist across restarts:** worked-topics ledger, daily counter + date, pillar tallies, queue depth. Use a LangGraph checkpointer — `InMemorySaver` is fine for the build; note precisely where the Postgres checkpointer slots in for production (the PRD's durable-audit and per-tenant-isolation requirements land here). This is the checkpointing spine, not the full audit database — that is a later phase.

#### Persist through the EXISTING storage layer — do not build a new one

After the inner graph produces the 5 packages and you assemble the batch envelope, persist by calling the existing `save_batch()` in `storage.py` exactly as `main.py` does today (`save_batch(batch, source=...)`), and trigger images via the existing `images.py` path. Do not create a parallel database or a second schema. The whole point of preserving the batch contract is that `storage.py` → `server.py` → `package-viewer.html` keep working untouched. If the daily-5 batch is assembled from 5 separate inner-graph runs, collect the 5 packages into one batch envelope (with correct `total_packages`, `ready_for_review_count`, `needs_review_count`) before calling `save_batch()`.

### Deliverables

1. A runnable `langgraph/` package with a clear entry point for a single inner-graph run and for the outer loop.
2. The `ContentState` schema, all node functions, the graph wiring, and the `gate_router` conditional edge with the integer cap.
3. Typed models (Pydantic or TypedDict) for SEO Brief, Fact Store, Draft Package, and both scorecards — matching the existing JSON contract exactly.
4. Web-search tool wiring for `research` and discovery.
5. Caps as named constants (`MAX_REVISIONS = 2`, `DAILY_DRAFT_CAP = 5`, queue-depth pause).
6. Integration with the existing `save_batch()` and image pipeline — no new storage layer.
7. A `README` covering: how to run a single topic and the outer loop; where `interrupt_before` and eventual WordPress publishing plug in; the Phase 1 vs Phase 2 model config and how to switch; and a note confirming the batch-JSON contract with the viewer.
8. A short validation script or documented steps that: runs the graph, calls `save_batch()` into a temp DB, starts `server.py`, and confirms the viewer renders the output — proving the contract survived.

### Do NOT

- Do not delete or edit the existing CrewAI code, `storage.py`, `images.py`, `server.py`, or `package-viewer.html` (beyond additive, contract-preserving changes if strictly required — and flag any such change to me first).
- Do not implement publishing, a WordPress tool, the dashboard, the full audit-log database, or the refresh monitor — out of scope.
- Do not invent a new output schema. The batch/package JSON shape is fixed by `Sample_Output.json` and `storage.py`.
- Do not put the revision cap, the daily cap, or the gate decision inside a model prompt. They live in code.
- Do not bundle the model swap into Phase 1.

### Order of work (follow this sequence)

1. Version check + read docs + read existing source (Step 0). Report versions and the exact batch contract you extracted.
2. `ContentState` + typed models matching the contract.
3. The four inner nodes carrying the ported prompts (Phase 1 models).
4. `gate_router` conditional edge with the integer cap + the two parallel gate fan-in.
5. `queue_handoff` with completeness/fabrication pre-checks, the two defect fixes, and `interrupt_before` seam.
6. Assemble batch envelope → call existing `save_batch()` → confirm viewer renders it. **Stop and report Phase 1 results.**
7. (After my go-ahead) Outer loop with pacing/ledger/checkpointer.
8. (After Phase 1 validated) Phase 2 model swap + known-failure-case regression tests.

Begin with Step 0 and report back before writing the schema.
