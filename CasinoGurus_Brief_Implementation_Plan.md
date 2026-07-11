# CasinoGurus Content Agent — Implementation Plan

**Status:** ALL CHANGES 1-9 COMPLETE and validated (2026-07-11). Crew runs on Claude Sonnet 5 (research + drafting) and Haiku 4.5 (discovery + gates + chat).
**Scope:** Prompt/config/content pass only. No orchestration changes, no revision loop, no LangGraph, no new deps/files (except editing `knowledge/user_preference.txt`).
**Source of truth:** `CasinoGurus_ Content Agent Brief.docx` — follow its section numbers; where the prompt and brief conflict, the brief wins.

References:
- Implementation prompt: `CasinoGurus_CrewAI_Content_Brief_Implementation_Prompt.md`
- Brief: `CasinoGurus_ Content Agent Brief.docx`

---

## Guardrails (hold to these throughout)

- **Output JSON contract unchanged** — no field renames/restructuring; same keys as `Sample_Output.json` consumed by `storage.py` / `images.py` / `server.py` / `package-viewer.html`. If any content edit would touch a field name/shape, STOP and ask.
- **Keep every working safety/compliance mechanism** — affiliate disclosure, 18+/21+ age line, responsible-gambling note, anti-fabrication rule (no invented casino names / per-operator figures), verification-flag rule, the compliance gate's verbatim-copy-before-FAIL pre-check, and the assembler completeness/fabrication pre-checks.
- **Surgical edits** — change the specific named sentences/rules; do not rewrite whole task blocks; keep everything §8.1 says is already correct.
- **No new dependencies, no new files** (only `user_preference.txt` content changes).

---

## Current state confirmed (files to edit)

- `main.py` — `voice_store` is still the literal `'sample_value'`.
- `knowledge/user_preference.txt` — still the "John Doe / AI Engineer / San Francisco" default.
- `config/tasks.yaml` — still has news queries, the MANDATORY TOPIC MIX RULE, `casinogurus.com`, the single forced skeleton, the "1–2 sentences" rule, and 1,200–1,600 word text.
- `config/agents.yaml` — topic agent still framed as an industry-news desk.
- `crew.py` — still on `openai/gpt-4.1`.

---

## Change 1 — Brand identity  ·  brief §1, §6a

**Files:** `main.py`, `knowledge/user_preference.txt`

- [x] `main.py`: add a labeled `CASINOGURUS_VOICE` constant with the §1 brand identity (.org domain, affiliate model, Dec-2025 Google-penalty recovery, THE ONE LANE = trusted crypto/Bitcoin casino reviews for US players, primary US audience, voice, and the explicit "what CasinoGurus is NOT" list).
- [x] `main.py`: replace `'voice_store': 'sample_value'` with that constant in **all** input dicts (`run`, `train`, `test`). Leave `revision_feedback`, `revision_count`, `escalation_reason` unchanged. Existing storage/image wiring stays.
- [x] `knowledge/user_preference.txt`: replace entire contents with the §1 brand brief.

---

## Change 2 — Repoint topic discovery to US player search intent  ·  brief §2, §4, §5, §6b, §6c, §6g

**Files:** `config/agents.yaml`, `config/tasks.yaml`

- [x] `agents.yaml` › `casino_content_topic_discovery_specialist`: rewrite role/goal/backstory to "models what a US crypto-casino player searches for when choosing where and how to play" (§6b). Remove the "monitors the gambling industry daily / regulatory changes / operator launches / regional market developments" framing.
- [x] `tasks.yaml` › `discover_daily_casino_topics` Step 2: replace news queries with player-intent seeds (§6c): "best bitcoin casino usa", "fastest payout crypto casino", "no kyc crypto casino", "is [casino] legit" + Google PAA and Reddit mining. Remove "online casino news [month] [year]" and "online gambling regulations [year]".
- [x] `tasks.yaml`: encode the single-topic test as an explicit acceptance gate (§2): "Would a US player deciding where to gamble with crypto actually type this into Google?" Reject operator/regulator/investor/analyst topics.
- [x] `tasks.yaml`: use the §4 categories as allowed good-topic shapes (comparison/ranking, individual reviews, how-to guides, safety/trust, US-state legality).
- [x] `tasks.yaml`: reweight the seven-dimension scoring (§6g) — down-weight freshness/trending, up-weight commercial/affiliate intent + evergreen player demand. Keep the 7-dimension structure.

---

## Change 3 — Enforce the single lane; remove pillar-mix  ·  brief §6d

**File:** `config/tasks.yaml` › `discover_daily_casino_topics`

- [x] Delete the "MANDATORY TOPIC MIX RULE" (forces 3+ pillars per batch of 5).
- [x] Replace with the single-lane rule: all 5 topics under crypto/Bitcoin casinos for US players; no multi-pillar spread required.
- [x] Update downstream references (expected_output notes, pillar language). Keep the `pillar` field in the schema; just stop enforcing a spread.

---

## Change 4 — Hard geo + audience filters  ·  brief §5, §6e, §6f

**File:** `config/tasks.yaml` › `discover_daily_casino_topics`

- [x] US-only geo filter (§6e): reject any topic whose focus is a non-US country; redefine "regional" pillar = US states only.
- [x] Player-facing audience filter (§6f): reject operator/regulator/investor/B2B topics; include the reject-on-sight blocklist (§5): "operators, market entry, licensing regime, regulatory regime, compliance framework, prediction markets, B2B" + any non-US country focus.
- [x] Verify the filters would reject all five §5 bad topics (prediction markets, Brazil operators, UK FRA, crypto regulation/compliance, Ireland licensing).

---

## Change 5 — Fix the domain bug  ·  brief §6h, §3

**File:** `config/tasks.yaml` › `discover_daily_casino_topics` Step 1

- [x] Change every `casinogurus.com` / `site:casinogurus.com` → `casinogurus.org` (the client's real site).
- [x] Add the namesake note: `casinoguru.com` / `casinogurus.com` is a different, larger company; never treat their pages as ours.

---

## Change 6 — Trim/correct competitor reference list  ·  brief §3, §7, §6i

**File:** `config/tasks.yaml` › `keyword_research_and_competitor_analysis` Step 2

- [x] Trim competitor list to §3 Tier-1/Tier-2 sources + §7 sample URLs. Keep "summarize structure/gaps, never copy prose".
- [x] Add the CasinoGuru.com namesake caution.

---

## Change 7 — Fix the drafting output (biggest change)  ·  brief §8

**Files:** `config/tasks.yaml` › `draft_casino_article` and `seo_and_quality_gate_check`; `agents.yaml` › `casinogurus_grounded_article_drafter`

- [x] **8.1** Keep the SEO skeleton explicitly: H2/H3 hierarchy, 6-question FAQ, Conclusion last, SEO title/meta/slug/tags/excerpt, affiliate disclosure + 18+/21+ line, RG note, schema recommendation. (Problem is content inside headings, not the headings.)
- [x] **8.2** Branch the template by content type — Review / Comparison-ranking / How-to / Legality-US-state — each keeping FAQ + Conclusion + disclosures + RG note; only the middle changes. Classify each topic at draft time using the discovery pillar/intent signal.
- [x] **8.3a** Remove the "every body paragraph must be exactly 1–2 sentences" rule; replace with "Vary paragraph and sentence length. Mostly short and scannable, but mix in a longer explanatory sentence so the rhythm sounds human."
- [x] **8.3b** Require first-hand specific detail where a fact-store entry supports it (coin + amount deposited, observed withdrawal time in minutes, cashier flow, specific game, what was good/annoying).
- [x] **8.3c** Never leave working placeholders in the visible body — forbid literal `[source]` etc. in `body_html`; source markers / verification flags / internal notes live only in `source_notes` / `verification_flags`.
- [x] **8.4a** Add a hard self-scan: em-dash and en-dash must not appear in ANY output field; rewrite offending sentences with period/comma/colon/parentheses.
- [x] **8.4b** Rewrite the mandatory boilerplate (age/jurisdiction line, RG line) so they contain no em/en dash in the first place.
- [x] **8.4c** `seo_and_quality_gate_check`: any em-dash/en-dash in a draft = automatic FAIL (do not break existing compliance-gate logic).
- [x] **8.5** `seo_and_quality_gate_check`: enforce a hard **1,200-word body floor** (reject/send back below it, not pass); target **1,200–1,800** for review/comparison (how-to & single-state legality allowed lower). Expansion must add genuine value, not filler. Keep the numbers as clearly-labeled editable values.
- [x] `agents.yaml` › drafter: adjust backstory/goal toward first-hand US crypto-expert voice, varied cadence, no dashes (structure rules stay in `tasks.yaml`).

---

## Change 8 — Intelligent discovery of hot US crypto casinos  ·  brief §9

**File:** `config/tasks.yaml` (discovery/research logic)

- [x] Step 1: pull current top-ranking crypto-casino pages (§3 Tier-2) and extract recurring casino names.
- [x] Step 2: cross-reference against the fixed affiliate-partner list — **PlayAmo, FortuneJack, El Royale, Slots Empire, BitStarz, Red Dog Casino**. Overlap (widely discussed AND a partner) = high-value topic (BitStarz clearest).
- [x] Step 3: propose review + comparison topics from the overlap first, then fill remaining slots with how-to / safety / US-state-legality from §4.
- [x] Bake in cautions: reference lists are affiliate-ranked (not neutral — any quality claim still needs a fact-store entry); **do NOT hard-code a hot-casino list** (regenerate from live sources each run; partner list is the only fixed list). The §9 name snapshot is illustrative only.

---

## Change 9 — Model configuration  ·  brief §10  ·  DO LAST, CONFIRM FIRST

**File:** `crew.py` — only after Changes 1–8 are done and explicitly approved.

- [x] Verify exact Claude model IDs and the brief's Sonnet-5 pricing/release-date claims against Anthropic's live docs (not from memory).
- [x] Set drafter → Claude Sonnet 5; mechanical checker/classification steps → Claude Haiku 4.5; keep Opus 4.8 / Fable 5 in reserve.
- [x] ⚠️ Implication to surface: crew currently runs on `openai/gpt-4.1`. Moving the drafter to Claude means a litellm string like `anthropic/claude-sonnet-5` and an **`ANTHROPIC_API_KEY`** in `.env` (in addition to the OpenAI key used by other steps/images).

---

## Post-change validation

- [x] Output contract intact: batch/package JSON shape unchanged; all fields consumed by `storage.py`/viewer still present and identically named.
- [x] Section 2 test bites: the five §5 bad topics would be rejected; §4 topic types accepted.
- [x] Drafting fixes enforceable by the checker: word-count floor rejects short drafts; em/en dash triggers auto-fail; no `[source]`/placeholder can appear in `body_html`.
- [x] Produce a concise summary of every file changed and every rule added/removed/edited, mapped to brief section numbers.

---

## Sequence

1. Changes **1–8** in order (agents/knowledge/main first, then `tasks.yaml`).
2. **Stop and report** for review.
3. Only after confirmation: Change **9** (`crew.py` model swap).

---

## Conflicts / notes

- No material conflicts found between the implementation prompt and the brief; the prompt maps faithfully to it.
- Two brief claims treated as *to-verify*, not settled: Sonnet-5 pricing/release dates (§10) and exact model IDs — both checked against Anthropic's live pages at Change 9.
