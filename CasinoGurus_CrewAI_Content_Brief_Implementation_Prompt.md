# CasinoGurus Content Agent — Brief Implementation Prompt (CrewAI)

You are making targeted changes to an existing, working CrewAI content-generation project. The goal is to fix a content/direction problem, not to re-architect anything. A reference document, **`CasinoGurus__Content_Agent_Brief.docx`**, is attached to this message. **That brief is the source of truth for all content, brand, voice, topic, and drafting decisions. Read it in full before editing anything, and follow its section numbers.** Where this prompt and the brief seem to conflict, follow the brief and flag the conflict to me.

Do not touch orchestration. The project stays on CrewAI with its current sequential process for now. Do not add LangGraph, do not add a revision loop, do not restructure the crew. This is a prompt/config/content pass only.

### Step 0 — Read before editing anything

1. **Read the attached brief `CasinoGurus__Content_Agent_Brief.docx` completely.** Note especially: the TL;DR (Section 0), the brand identity (Section 1), the single topic test (Section 2), the reference/competitor tiers (Section 3), the good/bad topic lists (Sections 4–5), the developer action list (Section 6), the article output fixes (Section 8), the intelligent discovery logic (Section 9), and the model recommendation (Section 10).
2. **Read the current project files you will be editing**, so every change is anchored to what is actually there:
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/main.py`
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/config/agents.yaml`
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/config/tasks.yaml`
   - `knowledge/user_preference.txt`
   - `src/casinogurus_ai_content_engine___daily_5_topic_batch/crew.py` (read only; edit only for the model change in the final section, and only after confirming with me)
3. **Before you start editing, produce a short change plan**: list each file you will touch and the specific edits you will make, mapped to the brief's section numbers. Wait for my go-ahead on the plan before making changes. Do not silently rewrite large blocks.

### Guardrails for the whole task

- **Preserve the output JSON contract.** The final task emits a batch object consumed by `storage.py`, `images.py`, `server.py`, and `package-viewer.html`. Do NOT change the shape, field names, or structure of the batch or package JSON (the keys in `Sample_Output.json`). You are changing what the agents are told to do and write, not the schema they emit into. If any content change would alter an output field's name or structure, stop and ask me first.
- **Keep every safety/compliance mechanism that already works.** Do not weaken or remove: the affiliate disclosure, the 18+/21+ age line, the responsible-gambling note, the anti-fabrication rule (no invented casino names or per-operator figures), the verification-flag rule, the compliance gate's verbatim-copy-before-FAIL pre-check, or the assembler completeness/fabrication pre-checks. The brief's changes sit alongside these, not instead of them.
- **Make surgical edits.** Prefer changing the specific sentences/rules named below over rewriting whole task descriptions. Keep the existing structure, formatting, and the parts the brief explicitly says are already correct (Section 8.1).
- **No new dependencies, no new files** for this task (except editing `knowledge/user_preference.txt` content). If you think a new file is warranted, ask first.

### Change 1 — Give the agent the brand identity (brief Sections 1, 6a)

The agent currently has no brand context: `voice_store` is passed as the literal string `'sample_value'` in `main.py`, and `knowledge/user_preference.txt` is the default "John Doe / AI Engineer / San Francisco" template. Fix both:

- In `main.py`, replace the `'sample_value'` placeholder for `voice_store` with the real CasinoGurus brand/voice context drawn from **brief Section 1** (site identity, .org domain, affiliate business model, the Google-penalty recovery situation, THE ONE LANE = trusted crypto/Bitcoin casino reviews for a US audience, the primary US audience, the voice, and the explicit "what CasinoGurus is NOT" list). Put the brand text in a clearly-labeled constant/string so it is easy to edit later, and interpolate it into the same `voice_store` input the tasks already use. Keep the other inputs (`revision_feedback`, `revision_count`, `escalation_reason`) as they are.
- Replace the contents of `knowledge/user_preference.txt` with the real CasinoGurus brand brief from Section 1, so the knowledge file reflects who the agent writes for instead of the "John Doe" default.

### Change 2 — Repoint topic discovery to US player search intent (brief Sections 2, 4, 5, 6b, 6c, 6g)

In `config/agents.yaml`, under `casino_content_topic_discovery_specialist`:

- Rewrite the role/goal/backstory so the agent "models what a US crypto-casino player searches for when choosing where and how to play," per **brief Section 6b**. Remove the current "monitors the gambling industry daily: regulatory changes, operator launches, regional market developments" framing.

In `config/tasks.yaml`, in the `discover_daily_casino_topics` task:

- **Replace the news-style search queries** (Step 2) with player-intent seeds per **brief Section 6c**: e.g. "best bitcoin casino usa", "fastest payout crypto casino", "no kyc crypto casino", "is [casino] legit", plus mining Google "People Also Ask" and Reddit for real player questions. Remove queries like "online casino news [month] [year]" and "online gambling regulations [year]".
- Encode **the single topic test from brief Section 2** as an explicit acceptance gate in the task: every proposed topic must pass "Would a US player deciding where to gamble with crypto actually type this into Google?" If it is something an operator/regulator/investor/industry analyst would read, reject it.
- Use the topic categories in **brief Section 4** (comparison/ranking, individual reviews, how-to guides, safety/trust, US-state legality) as the allowed shapes of good topics.
- **Reweight scoring** per **brief Section 6g**: down-weight freshness/trending, up-weight commercial/affiliate intent and evergreen player search demand. Keep the existing seven-dimension scoring structure but adjust the emphasis in the instructions.

### Change 3 — Enforce the single lane; remove the pillar-mix rule (brief Section 6d)

In `config/tasks.yaml`, `discover_daily_casino_topics`:

- **Delete the "MANDATORY TOPIC MIX RULE"** that forces 3+ pillars per batch of 5.
- Replace it with the single-lane rule from **brief Section 6d**: all 5 topics must sit under crypto/Bitcoin casinos for US players. The batch is not required to span multiple pillars; it is required to stay in the one lane.
- Update any downstream references (expected_output notes, pillar language) so nothing still assumes or requires a multi-pillar mix. Note: the output schema still carries a `pillar` field per package — keep the field, just stop enforcing a spread across pillars.

### Change 4 — Add hard geo and audience filters (brief Sections 5, 6e, 6f)

In `config/tasks.yaml`, `discover_daily_casino_topics`, add two explicit reject filters:

- **US-only geo filter (Section 6e):** reject any topic whose focus is a non-US country. Redefine the "regional" pillar to mean **US states only**.
- **Player-facing audience filter (Section 6f):** reject operator/regulator/investor/B2B topics. Include the **reject-on-sight keyword blocklist from brief Section 5**: "operators, market entry, licensing regime, regulatory regime, compliance framework, prediction markets, B2B", plus any non-US country name as the focus.
- For context, the brief's Section 5 shows the five bad topics from the last run and why each fails; make sure your filters would reject all five.

### Change 5 — Fix the domain bug (brief Section 6h)

In `config/tasks.yaml`, `discover_daily_casino_topics`, Step 1 currently instructs the agent to check `casinogurus.com` / `site:casinogurus.com`. This is the **wrong site** — it is the competitor near-namesake. Change every such reference to **`casinogurus.org`** (the client's real site) so the "avoid duplicates" check reads our own content. Per **brief Section 3**, also add a note that `casinoguru.com` / `casinogurus.com` is a different, larger company and the agent must never treat their pages as ours.

### Change 6 — Trim and correct the competitor/reference list (brief Sections 3, 7, 6i)

In `config/tasks.yaml` (the research/competitor-analysis step, `keyword_research_and_competitor_analysis`, Step 2):

- Trim the competitor reference list to the crypto/US-relevant sources named in **brief Section 3 (Tier 1 and Tier 2)** and the sample URLs in **Section 7**. Keep the "summarize structure/gaps, never copy prose" rule that is already there.
- Add the namesake caution from Section 3 so the agent never treats CasinoGuru.com content as CasinoGurus.org content.

### Change 7 — Fix the drafting output (brief Section 8) — the biggest change

All of these edit the `draft_casino_article` task in `config/tasks.yaml` and, where noted, the `casinogurus_grounded_article_drafter` agent in `agents.yaml`. Apply every sub-point:

- **8.1 Keep the SEO skeleton.** Do NOT change the parts the brief says are already right: H2/H3 hierarchy, 6-question FAQ block, Conclusion as the last section, SEO title/meta/slug/tags/excerpt, the affiliate disclosure and 18+/21+ line, the responsible-gambling note, and the schema recommendation. The problem is the content inside the headings, not the headings.
- **8.2 Branch the template by content type.** Replace the single forced skeleton (Introduction, Types, Best Offers, How to Claim, Terms Explained, FAQ, Conclusion) with a template that branches on the topic's content type, per **brief Section 8.2**: Review, Comparison/ranking, How-to guide, and Legality (US state) each get their own middle structure. Every type keeps the FAQ, the Conclusion, the disclosures, and the responsible-gambling note; only the middle changes. You will need a content-type signal — classify each topic into one of these types at draft time (the discovery output already carries pillar/intent you can use) and select the matching skeleton.
- **8.3 Write like a real US crypto-gambling expert.** Two required fixes: (1) **Remove the "every body paragraph must be exactly 1–2 sentences" rule** — the brief names it as the main cause of the robotic cadence — and replace it with: "Vary paragraph and sentence length. Mostly short and scannable, but mix in a longer explanatory sentence so the rhythm sounds human." (2) **Require first-hand, specific detail** wherever a fact-store entry supports it (actual coin and amount deposited, observed withdrawal time in minutes, cashier flow, a specific game played, what was good/annoying). This is the E-E-A-T signal. Also: **never leave working placeholders in the visible body** — the current drafts leak a literal "[source]" into reader-facing text; source markers, verification flags, and internal notes must live only in `source_notes` / `verification_flags`, never in `body_html`.
- **8.4 No em-dashes or en-dashes, anywhere (hard rule).** Two required changes: (1) Add a mandatory self-scan in the drafting step: the em-dash and en-dash characters must not appear in ANY output field; rewrite any sentence that would use one using a period, comma, colon, or parentheses. (2) **Rewrite the mandatory boilerplate templates** (age/jurisdiction line, responsible-gambling line) so they contain no em-dash or en-dash in the first place — the agent is currently instructed to paste one in, so the self-scan alone is insufficient. Additionally, update the SEO/quality checker task (`seo_and_quality_gate_check`) so any em-dash or en-dash in a draft is an automatic FAIL for that draft. (Do not break the existing compliance-gate logic while adding this.)
- **8.5 Enforce a real word-count floor.** The pipeline says 1,200–1,600 but drafts come out ~620–870. Set a **hard floor of 1,200 words of body copy** that the quality checker (`seo_and_quality_gate_check`) actually rejects below (send back for expansion, not pass), and a **target range of 1,200–1,800** for review/comparison pages, with how-to and single-state legality pages allowed at the lower end. Expansion must add genuine value (more first-hand detail, real comparison, fuller FAQ), never filler or repetition. Keep the numbers as clearly-labeled, easily-editable values.

### Change 8 — Make topic discovery intelligent about hot US crypto casinos (brief Section 9)

In `config/tasks.yaml`, extend the discovery/research logic to do the three ordered steps in **brief Section 9**:

1. Pull the current top-ranking crypto-casino pages (the Tier 2 sources in Section 3) and extract which casino names recur across them.
2. Cross-reference those names against the casinos CasinoGurus can monetise — the affiliate partners named in Section 9: **PlayAmo, FortuneJack, El Royale, Slots Empire, BitStarz, Red Dog Casino**. A casino that is both widely discussed and a partner is a high-value topic (BitStarz is the clearest example).
3. Propose review and comparison topics from that overlap first, then fill remaining slots with how-to, safety, and US-state-legality topics from Section 4.

Bake in the two cautions from Section 9: the reference lists are affiliate-ranked and not neutral (use them to spot what is *talked about*, not as proof a casino is good; any quality claim still needs a fact-store entry), and **do NOT hard-code a casino list into the config** — regenerate the recurring-names list from live sources each run. The affiliate-partner list is the only fixed list; treat the "hot names" as dynamic. (Section 9's snapshot of names like BitStarz, Mega Dice, Betpanda, CoinCasino, etc. is illustrative only and will drift — do not hard-code it.)

### Change 9 — Model configuration (brief Section 10) — do this LAST and confirm with me first

The brief's model guidance (Section 10): **Claude Sonnet 5 for drafting**, **Claude Haiku 4.5 for the cheap mechanical steps** (topic reject filters, classification, completeness checks), keep Opus 4.8 / Fable 5 in reserve. The brief stresses the model is NOT the current bottleneck — the prompts are — so **fix Changes 1–8 first, and treat the model swap as a separate, final, optional step.**

- Do not change any model in `crew.py` until Changes 1–8 are complete and I have confirmed.
- When I confirm, verify the exact current model identifiers against Anthropic's documentation before editing (do not assume the model string from memory), then set the drafter to Sonnet 5 and the mechanical checker/classification steps to Haiku 4.5. The brief cites specific pricing and release dates for Sonnet 5 — treat those as claims to verify against Anthropic's live pricing page, not as settled facts, before relying on them for cost decisions.

### After the changes — validate

1. **Confirm the output contract is intact:** the batch/package JSON shape is unchanged. Run the pipeline (or a dry check of the task `expected_output` blocks) and confirm the fields consumed by `storage.py` / the viewer are all still present and named identically.
2. **Confirm the Section 2 test bites:** the five bad topics from brief Section 5 would now be rejected, and the topic types from Section 4 would be accepted.
3. **Confirm the drafting fixes are enforceable by the checker:** word-count floor rejects short drafts; em-dash/en-dash triggers an automatic fail; no "[source]" or other placeholder can appear in `body_html`.
4. Produce a concise summary of every file changed and every rule added/removed/edited, mapped to the brief's section numbers, so I can review against the document.

### Do NOT

- Do not change the orchestration, add a revision loop, or begin the LangGraph migration.
- Do not change the output JSON schema or any field consumed by `storage.py` / `images.py` / `server.py` / `package-viewer.html`.
- Do not remove or weaken the existing compliance, anti-fabrication, verification-flag, or assembler completeness checks.
- Do not hard-code a "hot casinos" list; only the affiliate-partner list is fixed.
- Do not swap models until Changes 1–8 are done and I confirm.

Start with Step 0: read the brief and the current files, then give me the change plan mapped to the brief's sections and wait for my go-ahead.
