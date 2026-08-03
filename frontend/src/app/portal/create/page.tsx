"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";
import PageHeader from "@/components/portal/PageHeader";
import PieceActionBar from "@/components/portal/PieceActionBar";
import PieceReviewPane from "@/components/portal/PieceReviewPane";
import Stepper from "@/components/portal/Stepper";
import { usePortal } from "@/components/portal/PortalShell";

/** The four content tiles — each maps 1:1 to an existing pipeline. */
const TILES = [
  {
    format: "blog",
    content_type: "long_form",
    icon: "B",
    title: "Blog",
    desc: "A long-form article — 1,200 to 1,500 words. Great for teaching, taking a position, or going deep on something.",
  },
  {
    format: "linkedin_post",
    content_type: "short_form",
    icon: "Li",
    title: "LinkedIn Post",
    desc: "A short professional post with a strong hook. Sized to work with LinkedIn's “see more” fold.",
  },
  {
    format: "youtube_long",
    content_type: "video",
    icon: "▶",
    title: "Video Script",
    desc: "A chaptered spoken script with hook, structured body, and CTA. For YouTube (5–10 minutes).",
  },
  {
    format: "youtube_short",
    content_type: "video",
    icon: "◨",
    title: "Reel Script",
    desc: "A 60–90 second vertical script with a punchy hook and fast beats. For Shorts and Reels.",
  },
];

type Step = "type" | "topicSource" | "topicList" | "typeTopic" | "progress" | "review";

const STEP_INDEX: Record<Step, number> = {
  type: 0,
  topicSource: 1,
  topicList: 1,
  typeTopic: 1,
  progress: 2,
  review: 3,
};

/** Phase grouping for the progress screen: honest thirds of the real
 *  pipeline stages, with the actual stage label as the action line. */
function phaseOf(stage: number, total: number): 0 | 1 | 2 {
  if (!total) return 0;
  const frac = stage / total;
  if (frac < 0.34) return 0;
  if (frac < 0.6) return 1;
  return 2;
}

export default function CreateWizard() {
  const router = useRouter();
  const { activeClientId } = usePortal();

  const [step, setStep] = useState<Step>("type");
  const [tile, setTile] = useState<(typeof TILES)[number] | null>(null);

  // Topic list state
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestRunId, setSuggestRunId] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [hint, setHint] = useState("");

  // Typed topic state
  const [typedTopic, setTypedTopic] = useState("");

  // Run / review state
  const [runId, setRunId] = useState<string | null>(null);
  const [runTopic, setRunTopic] = useState<string>("");
  const [progress, setProgress] = useState<any | null>(null);
  const [reviewPiece, setReviewPiece] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Set when the engine was busy (e.g. Autopilot mid-piece): the wizard
  // retries automatically instead of erroring out.
  const [waitingRun, setWaitingRun] = useState<"fromTopic" | "typed" | null>(null);

  const reset = () => {
    setStep("type");
    setTile(null);
    setSuggestions([]);
    setSuggestRunId(null);
    setSelectedTopicId(null);
    setHint("");
    setTypedTopic("");
    setRunId(null);
    setRunTopic("");
    setProgress(null);
    setReviewPiece(null);
    setError(null);
  };

  useEffect(() => {
    reset(); // workspace switch restarts the wizard
  }, [activeClientId]);

  const loadSuggestions = useCallback(async () => {
    if (!tile) return;
    setSuggestionsLoading(true);
    try {
      const res = await apiFetch(`/api/portal/topic-suggestions?format=${encodeURIComponent(tile.format)}`);
      const data = await res.json().catch(() => []);
      setSuggestions(Array.isArray(data) ? data : []);
    } catch {
      setSuggestions([]);
    }
    setSuggestionsLoading(false);
  }, [tile]);

  useEffect(() => {
    if (step === "topicList") {
      setSelectedTopicId(null);
      loadSuggestions();
    }
  }, [step, loadSuggestions]);

  // Poll the suggestion round until it lands, then refresh in place.
  useEffect(() => {
    if (!suggestRunId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch("/api/portal/runs");
        const runs = await res.json().catch(() => []);
        const row = Array.isArray(runs) ? runs.find((r: any) => String(r.id) === suggestRunId) : null;
        if (cancelled || !row) return;
        if (row.status === "succeeded") {
          setSuggestRunId(null);
          loadSuggestions();
        } else if (row.status === "failed" || row.status === "cancelled") {
          setSuggestRunId(null);
          setError("Topic research didn't complete — try again.");
        }
      } catch {
        /* transient poll failure */
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [suggestRunId, loadSuggestions]);

  const startSuggest = async () => {
    if (!tile) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/portal/suggest-topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content_type: tile.content_type,
          format: tile.format,
          hint: hint.trim() || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.run_id) setSuggestRunId(String(data.run_id));
      else if (res.status === 409)
        setError("The engine is busy with another piece right now — try again in a few minutes.");
      else setError(String(data.detail || data.error || `Request failed (${res.status})`));
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    }
    setSubmitting(false);
  };

  const startRun = async (kind: "fromTopic" | "typed") => {
    if (!tile) return;
    setSubmitting(true);
    setError(null);
    try {
      let res: Response;
      let topicLabel = "";
      if (kind === "fromTopic") {
        const chosen = suggestions.find((s) => String(s.id) === selectedTopicId);
        topicLabel = chosen?.topic ?? "";
        res = await apiFetch("/api/portal/generate-from-suggestions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suggestion_ids: [selectedTopicId] }),
        });
      } else {
        topicLabel = typedTopic.trim();
        res = await apiFetch("/api/portal/run-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content_type: tile.content_type,
            format: tile.format,
            topic: typedTopic.trim(),
          }),
        });
      }
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.run_id) {
        setWaitingRun(null);
        setRunId(String(data.run_id));
        setRunTopic(topicLabel);
        setStep("progress");
      } else if (res.status === 409) {
        // Engine busy (often Autopilot finishing a piece) — wait politely
        // and retry; humans always get the next free slot.
        setWaitingRun(kind);
      } else {
        setError(String(data.detail || data.error || `Request failed (${res.status})`));
      }
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    }
    setSubmitting(false);
  };

  // Auto-retry while waiting for the engine (every 30s until it takes).
  useEffect(() => {
    if (!waitingRun) return;
    const timer = setInterval(() => startRun(waitingRun), 30_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingRun]);

  // Progress polling: stage progress + run completion → review.
  useEffect(() => {
    if (step !== "progress" || !runId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const [progRes, runsRes] = await Promise.all([
          apiFetch("/api/portal/run-progress"),
          apiFetch("/api/portal/runs"),
        ]);
        const prog = await progRes.json().catch(() => null);
        const runs = await runsRes.json().catch(() => []);
        if (cancelled) return;
        if (prog && typeof prog.total === "number") setProgress(prog);
        const row = Array.isArray(runs) ? runs.find((r: any) => String(r.id) === runId) : null;
        if (row?.status === "succeeded") {
          const piecesRes = await apiFetch("/api/portal/pieces");
          const pieces = await piecesRes.json().catch(() => []);
          const mine = (Array.isArray(pieces) ? pieces : []).find(
            (p: any) => p.batch_id === row.batch_id
          );
          if (!cancelled && mine) {
            const detailRes = await apiFetch(`/api/portal/pieces/${encodeURIComponent(mine.package_id)}`);
            const detail = await detailRes.json().catch(() => null);
            if (!cancelled && detail?.package_id) {
              setReviewPiece(detail);
              setStep("review");
            }
          } else if (!cancelled) {
            router.push("/portal/drafts");
          }
        } else if (row?.status === "failed") {
          if (!cancelled) {
            setError("This piece didn't complete — our team has been notified. Please try again.");
            setStep(selectedTopicId ? "topicList" : "typeTopic");
            setRunId(null);
          }
        }
      } catch {
        /* transient */
      }
    };
    poll();
    const timer = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [step, runId, router, selectedTopicId]);

  const stepper = <Stepper steps={["Type", "Topic", "Write", "Review"]} current={STEP_INDEX[step]} />;
  const phase = progress ? phaseOf(progress.stage ?? 0, progress.total ?? 0) : 0;
  const suggesting = suggestRunId !== null;

  const tileTitle = tile ? ` · ${tile.title}` : "";

  return (
    <>
      <PageHeader
        title={step === "progress" ? "Writing your piece…" : `Create${tileTitle}`}
        subtitle={
          step === "type"
            ? "Pick what you want to make"
            : step === "topicSource"
              ? "Where should we get the topic from?"
              : step === "topicList"
                ? "Pick a topic to write about"
                : step === "typeTopic"
                  ? "Tell us what to write about"
                  : step === "progress"
                    ? runTopic
                    : "Review your piece"
        }
      >
        {step !== "type" && step !== "progress" && (
          <button
            onClick={() =>
              setStep(step === "topicSource" ? "type" : step === "review" ? "type" : "topicSource")
            }
            className="rounded-md border border-cs-border-strong bg-white px-3.5 py-2 text-[13px] font-medium hover:border-cs-light"
          >
            ← Back
          </button>
        )}
      </PageHeader>

      <div className="max-w-[1200px] px-8 py-6 pb-20">
        {step !== "progress" && stepper}

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-cs-danger-soft px-4 py-3 text-[13px] text-cs-danger">
            {error}
          </div>
        )}

        {waitingRun && (
          <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-indigo-200 bg-cs-accent-soft px-4 py-3 text-[13px] text-indigo-900">
            <span className="inline-block animate-spin">◌</span>
            The engine is finishing another piece — yours will start automatically in a few minutes.
            You can keep this page open.
            <button
              onClick={() => setWaitingRun(null)}
              className="ml-auto text-indigo-400 hover:text-indigo-700"
              title="Stop waiting"
            >
              ✕
            </button>
          </div>
        )}

        {/* ---- Step 1: content type ---- */}
        {step === "type" && (
          <>
            <h2 className="mb-1.5 text-[22px] font-bold tracking-[-0.4px]">What are we making today?</h2>
            <p className="mb-5 text-cs-muted">
              One click on any of these. One content type per piece — a blog and a reel about the
              same idea is two Creates.
            </p>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3">
              {TILES.map((t) => (
                <button
                  key={t.format}
                  onClick={() => {
                    setTile(t);
                    setStep("topicSource");
                    setError(null);
                  }}
                  className="rounded-[10px] border-[1.5px] border-cs-border bg-white p-5 text-left transition-all hover:-translate-y-px hover:border-cs-accent hover:shadow-cs-md"
                >
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-cs-accent-soft text-lg font-bold text-cs-accent">
                    {t.icon}
                  </div>
                  <div className="mb-1 text-[14.5px] font-semibold tracking-[-0.2px]">{t.title}</div>
                  <div className="text-[12.5px] leading-[1.45] text-cs-muted">{t.desc}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {/* ---- Step 2: topic source ---- */}
        {step === "topicSource" && tile && (
          <>
            <h2 className="mb-1.5 text-[22px] font-bold tracking-[-0.4px]">
              Do you already have a topic, or should we suggest some?
            </h2>
            <p className="mb-5 text-cs-muted">Pick either — takes about the same time.</p>
            <div className="grid grid-cols-2 gap-3">
              <button
                onClick={() => setStep("topicList")}
                className="rounded-[10px] border-[1.5px] border-cs-border bg-white p-6 text-left transition-all hover:border-cs-accent hover:shadow-cs-md"
              >
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-cs-accent-soft text-lg">
                  💡
                </div>
                <div className="mb-1 text-[14.5px] font-semibold">Show me topic ideas</div>
                <div className="text-[12.5px] leading-[1.45] text-cs-muted">
                  We'll research topic ideas based on your brand voice and what you've published.
                  Pick the one you like — the rest stay available for later.
                </div>
              </button>
              <button
                onClick={() => setStep("typeTopic")}
                className="rounded-[10px] border-[1.5px] border-cs-border bg-white p-6 text-left transition-all hover:border-cs-accent hover:shadow-cs-md"
              >
                <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-cs-accent-soft text-lg">
                  ✏
                </div>
                <div className="mb-1 text-[14.5px] font-semibold">I have a topic in mind</div>
                <div className="text-[12.5px] leading-[1.45] text-cs-muted">
                  Type your topic in a sentence or two and we get straight to writing.
                </div>
              </button>
            </div>
          </>
        )}

        {/* ---- Step 3a: topic list ---- */}
        {step === "topicList" && tile && (
          <>
            <h2 className="mb-1 text-[22px] font-bold tracking-[-0.4px]">
              {suggestions.length > 0 ? "Topic ideas for you" : "Let's find some topic ideas"}
            </h2>
            <p className="mb-4 text-cs-muted">
              Researched against your brand voice and current search demand. Click one to select,
              then write the piece.
            </p>

            <div className="mb-4 flex items-center gap-2">
              <input
                value={hint}
                onChange={(e) => setHint(e.target.value)}
                maxLength={300}
                placeholder="Anything specific in mind? e.g. gift guides (optional)"
                className="flex-1 rounded-md border border-cs-border-strong bg-white px-3 py-2 text-[13px] outline-none focus:border-cs-accent"
              />
              <button
                onClick={startSuggest}
                disabled={submitting || suggesting}
                className={`rounded-md border px-4 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed ${
                  suggesting
                    ? "animate-pulse border-cs-accent/50 bg-white text-cs-accent"
                    : "border-cs-border-strong bg-white hover:border-cs-light disabled:opacity-50"
                }`}
              >
                {suggesting
                  ? "◌ Researching topics… (2–4 min)"
                  : suggestions.length > 0
                    ? "↻ Show me more"
                    : "✦ Suggest topics"}
              </button>
            </div>

            {suggestionsLoading ? (
              <div className="rounded-[10px] border border-cs-border bg-white p-6 text-cs-muted shadow-cs">
                Loading topics…
              </div>
            ) : suggestions.length === 0 ? (
              <div className="rounded-[10px] border border-cs-border bg-white p-6 text-cs-muted shadow-cs">
                {suggesting
                  ? "The agent is researching topic ideas — they'll appear right here in a couple of minutes. You can keep this page open."
                  : "No topics yet for this format — click “Suggest topics” to get researched ideas."}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {suggestions.map((s) => {
                  const id = String(s.id);
                  const selected = id === selectedTopicId;
                  return (
                    <button
                      key={id}
                      onClick={() => setSelectedTopicId(selected ? null : id)}
                      className={`rounded-lg border-[1.5px] p-4 text-left transition-all ${
                        selected
                          ? "border-cs-accent bg-cs-accent-soft"
                          : "border-cs-border bg-white hover:border-cs-accent hover:shadow-cs-md"
                      }`}
                    >
                      <div className="mb-1.5 text-[14.5px] font-semibold leading-[1.35] tracking-[-0.15px]">
                        {s.topic}
                      </div>
                      {s.rationale && (
                        <div className="mb-2.5 text-[12.5px] leading-[1.5] text-cs-muted">{s.rationale}</div>
                      )}
                      {s.pillar && (
                        <span className="rounded-full bg-cs-gray-soft px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider text-cs-muted">
                          {s.pillar}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {suggestions.length > 0 && (
              <div className="mt-5 flex justify-end">
                <button
                  onClick={() => startRun("fromTopic")}
                  disabled={!selectedTopicId || submitting || suggesting}
                  className="rounded-md border border-cs-accent bg-cs-accent px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "Starting…" : "Write this piece →"}
                </button>
              </div>
            )}
          </>
        )}

        {/* ---- Step 3b: typed topic ---- */}
        {step === "typeTopic" && tile && (
          <>
            <h2 className="mb-1.5 text-[22px] font-bold tracking-[-0.4px]">What's the topic?</h2>
            <p className="mb-5 text-cs-muted">A sentence or two — we write on this exact angle.</p>
            <div className="rounded-[10px] border border-cs-border bg-white p-6 shadow-cs">
              <label className="mb-1.5 block text-[13px] font-medium">Your topic</label>
              <textarea
                value={typedTopic}
                onChange={(e) => setTypedTopic(e.target.value)}
                maxLength={300}
                rows={3}
                placeholder="e.g. Why I stopped offering hourly billing and what I do instead"
                className="w-full resize-y rounded-md border border-cs-border-strong bg-white px-3 py-2.5 text-[13.5px] outline-none focus:border-cs-accent focus:ring-[3px] focus:ring-cs-accent-soft"
              />
              <div className="mt-1 text-xs text-cs-muted">{typedTopic.trim().length} / 300</div>
              <div className="mt-4 flex items-center justify-between gap-3">
                <div className="text-[11.5px] text-cs-muted">
                  You'll review the piece before anything is used.
                </div>
                <button
                  onClick={() => startRun("typed")}
                  disabled={!typedTopic.trim() || submitting}
                  className="rounded-md border border-cs-accent bg-cs-accent px-5 py-2.5 text-[13.5px] font-medium text-white hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "Starting…" : "Write this piece →"}
                </button>
              </div>
            </div>
          </>
        )}

        {/* ---- Step 4: progress ---- */}
        {step === "progress" && (
          <>
            <div className="mb-5 rounded-xl border border-cs-border bg-white px-8 py-10 text-center shadow-cs">
              <div className="mb-2 text-xs uppercase tracking-widest text-cs-muted">Working</div>
              <div className="mb-5 text-[22px] font-semibold tracking-[-0.3px]">
                {progress?.label ? `${progress.label}…` : "Getting started…"}
              </div>
              <div className="mx-auto mb-3 h-2.5 max-w-[480px] overflow-hidden rounded-full bg-cs-gray-soft">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-cs-accent to-indigo-400 transition-all duration-700"
                  style={{
                    width:
                      progress && progress.total
                        ? `${Math.max(6, Math.round((100 * (progress.stage ?? 0)) / progress.total))}%`
                        : "6%",
                  }}
                />
              </div>
              <div className="text-[13px] text-cs-muted">
                You can navigate away — the piece will land in Drafts when it's done.
              </div>

              <div className="mt-6 grid grid-cols-3 gap-3 text-left">
                {["Researching", "Drafting", "Reviewing"].map((name, i) => (
                  <div
                    key={name}
                    className={`rounded-lg border p-3.5 ${
                      i < phase
                        ? "border-cs-accent bg-cs-accent-soft"
                        : i === phase
                          ? "border-blue-400 bg-blue-50"
                          : "border-cs-border bg-cs-gray-soft"
                    }`}
                  >
                    <div className="text-[10.5px] font-semibold uppercase tracking-wider text-cs-muted">
                      Step {i + 1} {i < phase ? "✓" : ""}
                    </div>
                    <div className="mt-0.5 text-[13.5px] font-semibold">
                      {name}
                      {i === phase ? "…" : ""}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="text-center text-[13px] text-cs-muted">
              <button onClick={() => router.push("/portal/drafts")} className="underline underline-offset-2 hover:text-cs-text">
                Go to Drafts
              </button>{" "}
              — this piece keeps writing in the background.
            </div>
          </>
        )}

        {/* ---- Step 5: review ---- */}
        {step === "review" && reviewPiece && (
          <div className="grid grid-cols-[1fr_320px] items-start gap-5">
            <PieceReviewPane piece={reviewPiece} />
            <div className="sticky top-20 rounded-xl border border-cs-border bg-white p-5 shadow-cs">
              <h4 className="mb-3 text-xs font-semibold uppercase tracking-widest text-cs-muted">
                What now?
              </h4>
              <PieceActionBar
                vertical
                pieceId={reviewPiece.package_id}
                state={reviewPiece.state}
                onChanged={(st) => {
                  if (st === "approved") router.push("/portal/approved");
                  else if (st === "rejected") router.push("/portal/drafts");
                  else setReviewPiece({ ...reviewPiece, state: st });
                }}
              />
              <div className="mt-5 border-t border-cs-border pt-3 text-[12.5px]">
                <div className="flex justify-between border-b border-cs-border py-1.5">
                  <span className="text-cs-muted">Content type</span>
                  <span className="font-medium">{tile?.title ?? reviewPiece.format}</span>
                </div>
                <div className="flex justify-between py-1.5">
                  <span className="text-cs-muted">Topic source</span>
                  <span className="font-medium">{selectedTopicId ? "Suggested" : "You typed it"}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
