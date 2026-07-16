# NEXUS Content Agent — Multi-Client Flow & Features

## Features Implemented

**Client management (onboarding)**
- Create/edit clients with a "hybrid" profile: fixed fields (voice, compliance rules, requirements, special instructions, etc.) where each value is freeform text your internal team writes.
- Profile edits are **append-only versions** — editing never overwrites; it creates v2, v3, etc. Runs already in progress keep using the version they started with.

**Content type / format selection**
- A registry (`registry.py`) defines what the engine can produce: right now `Long-form → Blog`. Selecting these before a run determines which pipeline parameters (word count, stage labels) apply.

**Run orchestration**
- Pick a client + content type + format → the crew runs using that client's profile instead of hardcoded CasinoGurus text.
- Live terminal log streaming (SSE) with dynamic stage labels and a "ClientName — format" subtitle.
- One run at a time (existing guard, unchanged).

**Review / feedback loop**
- Each generated article gets Shortlist / Approve / Reject buttons + optional notes. This is captured as an event log (`package_reviews`) — the raw material for the future learning loop (not yet auto-applied to generation).

**Dashboard**
- Client switcher filters the batch list; batch cards and headers show client + format.

---

## End-to-End User Flow

### Step 1 — Create a client profile

You go to `/clients` → "+ New Client" → fill in:

| Field | What you type | What it's used for |
|---|---|---|
| Client Name / Site Domain | e.g. "Acme Fintech" / "acme.com" | Injected as `{client_name}` / `{client_site}` everywhere in prompts |
| **Voice** | Who they are, audience, tone | Becomes `{voice_store}` — same role as the old hardcoded `CASINOGURUS_VOICE` |
| **Compliance Rules** | The exact PASS/FAIL checklist for this industry | Becomes `{compliance_rules}` — goes straight into the compliance-gate agent's prompt |
| **Content Requirements** | What this client needs from content | Appended to the voice context (only if non-empty) |
| **Special Instructions** | Any other dos/don'ts | Appended to the voice context (only if non-empty) |
| Pillar Taxonomy | Content categories, one per line | Rendered into the topic/pillar enum used by discovery + assembly |
| *(Advanced, collapsed by default)* Topic discovery playbook, competitor refs, content skeletons, word count rules, banned phrases, mandatory legal language, agent personas, lexicon | Client-specific pipeline mechanics — pre-filled with sensible values you can override per client | Each maps 1:1 to a `{placeholder}` in `tasks.yaml`/`agents.yaml` |

Click **Create Client** → this calls `POST /api/clients` → backend validates the profile (rejects any stray `{token}` text, checks all required fields present) → inserts the client row + **profile version 1**.

### Step 2 — Run the agent

Click **▶ Run Agent** in the sidebar → a modal opens:

1. **Client** — dropdown of active clients (pre-selected from whichever client you have filtered in the sidebar switcher)
2. **Content Type** — from the registry, currently just "Long-form"
3. **Format** — from the registry, currently just "Blog Article"

Click **Run Agent** → `POST /api/run-agent {client_id, content_type, format}`. Backend:
- Validates the format exists/is enabled and matches the content type (422 if not)
- Validates the client exists and is active (404/409 if not)
- Creates a **`runs` row**, pinning the client's *current* profile version (so a mid-run profile edit can't change what this run uses)
- Writes an `[AGENT_RUN]` header line to the log (client name, format, stage labels) — this is what makes the terminal UI show the right labels
- Spawns the crew subprocess with only `--run-id <uuid>` — the subprocess looks everything else up from the DB using that ID

### Step 3 — Inside the run (how the inputs actually get used)

`main.py` loads the pinned profile → `profile.build_inputs()` assembles the CrewAI kickoff dict — every field you typed becomes a named key:

```
voice_store        = profile.voice + any requirements/special_instructions
compliance_rules   = profile.compliance_rules
topic_discovery_playbook, competitor_refs, content_skeletons,
word_count_rules, banned_phrases, mandatory_language, ...
pillar_enum        = rendered from your pillar list
client_name, client_site
```

These get substituted into the exact same `{placeholder}` spots in `agents.yaml`/`tasks.yaml` that used to contain hardcoded CasinoGurus text — so the **same 6-agent pipeline** (Topic Discovery → Keyword/Competitor Research → Draft → Compliance Gate → SEO Gate → Assemble) runs, just reading your client's text instead.

The terminal modal streams this live: progress bar advances per `[AGENT_PROGRESS]` line, labeled with the stages from your format's registry entry.

### Step 4 — Review the output

Batch appears in the sidebar (tagged with client + format chips). Open it → each package (article) shows Draft / Compliance / SEO tabs as before, plus the new **feedback bar**: Shortlist / Approve / Reject + notes. Clicking one calls `POST /api/packages/{id}/feedback` → appends an event row tied to that client.

### Step 5 — Iterate

- Edit the client's profile again later (e.g. tighten compliance rules) → Save creates **version 2**. The batch you already reviewed keeps its stamped `profile_version: 1`; the *next* run for that client uses v2.
- Approve/reject history accumulates per client — this is what a future "learning loop" phase would read to auto-adjust generation (that distillation step isn't built yet; right now it's just captured).

**In short:** profile fields → `build_inputs()` → YAML placeholders → same crew pipeline → tagged batch → feedback loop, with client isolation and version pinning at every step.
