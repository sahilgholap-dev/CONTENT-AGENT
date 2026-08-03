# Content Studio portal UI/UX refactor (light theme, wizard, pieces)

**Date:** 2026-08-03
**Status:** Approved by Sahil (scope decisions in session)
**References:** `Content_Studio_Refactor_Brief_for_Claude_Code.md` + `Content_Studio_Client_UI_Mockup_v1.html` (visual truth), reduced to existing functionality per Sahil's decisions.

## Problem

The client portal leaks internal taxonomy (batches, packages, long/short form),
reads engineer-dark, and generates before the client ever sees a topic. The
mockup defines a light, client-shaped UI: a Create wizard (type → topic →
write → review), a Drafts queue, and an Approved library.

## Scope decisions (made with user, overriding the brief where noted)

1. **UI/UX only.** Re-skin and re-flow the portal over functionality that
   already exists. NO new product behaviour.
2. **No new pipelines** (brief's LinkedIn Carousel, LinkedIn video, TikTok /
   Instagram reel variants are deferred). Create offers exactly the four
   existing pipelines: Blog→`blog` (long_form), LinkedIn Post→`linkedin_post`
   (short_form), Video Script→`youtube_long` (video), Reel Script→
   `youtube_short` (video). No platform sub-choice steps.
3. **Topic discovery stays the shipped async suggest flow** (suggest run →
   poll → `topic_suggestions`), restyled as the mockup's topic cards. The
   brief's synchronous `POST /topics/discover` contract is rejected.
4. **Autopilot is future scope.** No nav item, no indicator, no queue, no
   scheduler. (Next project after this refactor.)
5. **Multi-business switcher is kept** — dropdown in the sidebar brand block
   (mockup omits it; it's a shipped feature and must not regress).
6. **Deferred with Autopilot:** Revise action, Mark-posted flag, per-piece
   downloads, topic library / star-save, intent badges, clarifying question,
   backend IG/FB removal (tiles simply absent from the portal UI; backend and
   admin untouched).
7. **Admin surface untouched.** `src/app/admin/**` and every component it
   imports (`Sidebar.tsx`, `BatchViewer.tsx`, `PackageViewer.tsx`,
   `FeedbackBar.tsx`, `TerminalLogs.tsx`, `RunAgentModal.tsx`,
   `TopicSuggestPanel.tsx`) are not modified. The portal stops importing
   them; the files stay.
8. **Account page kept**, restyled light (brief said delete; it is live
   functionality).

## Design

### Theme & shell
- Design tokens from the mockup's `:root` land in `globals.css` under a
  `.portal-theme` scope (Tailwind v4 `@theme` / CSS variables), so admin
  keeps its dark look untouched.
- New `src/app/portal/layout.tsx`: 240px dark-navy sidebar (brand block +
  workspace dropdown when >1 business, nav: Create / Drafts / Approved,
  user box + sign-out) + light main area with topbar. Sidebar lives in
  `src/components/portal/Sidebar.tsx` (new file; the old shared Sidebar.tsx
  stays admin-only).
- `/portal` (page.tsx) becomes a redirect to `/portal/drafts` (the proxy
  and login flow stay untouched).
- `login/page.tsx` restyled to the mockup's card (logic unchanged).

### Pieces read model (the one backend addition)
- `GET /api/portal/pieces` — flat, client-scoped list assembled from
  existing tables: one item per package with `piece_id (package_id)`,
  `title (topic)`, `content_type`, `format`, `created_at`,
  `state` (latest package_reviews event, else "drafted"),
  `requested_topic`, `batch_id`. Read-only; no schema change.
- `GET /api/portal/pieces/{id}` — single package payload (the shape
  PackageViewer consumes today) + state. Reuses existing scoping helpers
  (`_portal_cid`, `_own_package_or_404`).
- States: drafted | shortlisted → Drafts view; approved → Approved view;
  rejected → hidden. Existing `POST /portal/packages/{id}/feedback` is the
  action endpoint (unchanged).

### Create wizard (`/portal/create`)
- Step machine in `create/page.tsx`; stepper: Type → Topic → Write → Review.
- **Step 1** four ContentTypeTiles (copy per mockup, minus Carousel).
- **Step 2** topic source: two tiles ("Show me topic ideas" / "I have a
  topic in mind").
- **Step 3a** topic list: on entry, load existing `topic_suggestions` for
  the format; "Suggest topics / Show me more" starts a suggest run
  (existing `POST /portal/suggest-topics`), shows an in-page "finding
  topics…" state while polling `/portal/runs`, then renders cards
  (headline = topic, sub-line = rationale, chip = pillar). Single-select;
  "Write this piece" calls existing `POST /portal/generate-from-suggestions`
  with exactly one id.
- **Step 3b** textarea (300 max) → existing `POST /portal/run-agent` with
  the topic pinned.
- **Step 4** progress: poll existing `/portal/run-progress`
  ({active, stage, total, label}); client-side mapping of stage index into
  three phase groups — first stage(s) → "Researching", drafting stage →
  "Drafting", remaining gates/assembly → "Reviewing" — with the raw stage
  label shown as the "what the agent is doing" line. No ETA. "You can
  navigate away — it lands in Drafts."
- **Step 5** review: when the run completes, load the newest piece and show
  it in the shared PieceReviewPane.

### Drafts (`/portal/drafts`, landing screen)
- Two-pane: left DraftListItem list (colour bar by content type, title,
  type chip, age; filter chips All / Blog / Posts / Videos / Reels;
  newest first), right PieceReviewPane.
- `drafts/[id]` deep-links a piece.
- PieceActionBar: Reject / Shortlist / Approve → existing feedback endpoint;
  identity comes from the session server-side (already the case).
  Reject = single click, no modal. Approve moves the piece to Approved.
- Bulk mode deferred? NO — bulk select with Approve/Reject all selected is
  pure frontend over the same endpoint (sequential calls); included.

### Approved (`/portal/approved`)
- Table per mockup: colour bar, title + word/slide sub-line, type chip,
  approved-at, Copy action (clipboard: plain markdown for blog, LinkedIn-
  ready text for posts, plain text for scripts — formatted client-side from
  the piece payload). Download column deferred (batch ZIP remains available
  in code but not surfaced here). No Mark-posted. Filters + title search.

### PieceReviewPane (shared)
- New portal renderer for blog (body_html), post (post_text/hashtags),
  video/reel (scenes) — informed by PackageViewer's shapes but written
  fresh under `src/components/portal/` in the light theme. Right/bottom
  action panel per context (Create step 5: side panel; Drafts: bottom bar).

## File inventory

Create: `src/app/portal/layout.tsx`, `create/page.tsx` (+ step components
under `src/components/portal/steps/`), `drafts/page.tsx`, `drafts/[id]/page.tsx`,
`approved/page.tsx`, `src/components/portal/{Sidebar, Stepper,
ContentTypeTile, TopicCard, PieceReviewPane, PieceActionBar, DraftListItem,
ApprovedRow, WorkspaceSwitcher}.tsx`.

Modify: `src/app/portal/page.tsx` (redirect), `src/app/portal/account/page.tsx`
(restyle), `src/app/login/page.tsx` (restyle), `src/app/globals.css` (tokens),
`app.py` + `storage.py` (the two pieces read endpoints), `lib/api.ts` (helpers).

Delete: `src/components/PortalRunModal.tsx` (portal-only, replaced by wizard).
Everything else shared stays for admin.

## Acceptance (adapted from the brief)

1. Everything under `/portal` renders the light design system; admin is
   byte-identical (`git diff --stat` shows no admin-route/component change
   besides the portal dropping imports).
2. Create produces exactly one piece per completed action (pinned-topic runs).
3. Drafts shows drafted+shortlisted pieces; Approved shows approved; rejected
   appear in neither.
4. Reject is single-click, no modal; reviewer identity from session.
5. Progress shows Researching / Drafting / Reviewing, never internal stage
   counts.
6. IG/FB caption tiles are not reachable anywhere in the portal UI.
7. Visual density matches the mockup side-by-side.
8. Multi-business logins can switch workspaces from the sidebar; all views
   re-scope.
9. `uv run pytest tests/` and `npx tsc --noEmit` pass.

## Build order

1. Tokens + portal layout/sidebar/login restyle (shell boots with empty pages).
2. Pieces endpoints (backend) + Drafts two-pane with real data + Approved.
3. Create wizard steps with the suggest flow + progress + review.
4. Account restyle, PortalRunModal deletion, dead-import sweep, acceptance
   pass vs mockup.
