"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import PageHeader from "@/components/portal/PageHeader";
import { usePortal } from "@/components/portal/PortalShell";

const CARDS = [
  { format: "blog", content_type: "long_form", icon: "B", title: "Blog", desc: "Long-form articles. Higher effort, lower frequency." },
  { format: "linkedin_post", content_type: "short_form", icon: "Li", title: "LinkedIn Post", desc: "Short posts. Best for a steady weekly presence." },
  { format: "youtube_long", content_type: "video", icon: "▶", title: "Video Script", desc: "Chaptered YouTube scripts (5–10 minutes)." },
  { format: "youtube_short", content_type: "video", icon: "◨", title: "Reel Script", desc: "60–90 second vertical scripts for Shorts and Reels." },
];

const TIMEZONES = [
  "Asia/Kolkata",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "UTC",
];

const SOURCE_LABEL: Record<string, string> = {
  pool: "Suggested topics (you pick, agent researches more when needed)",
  manual: "Your own topics",
  auto: "Fully automatic (agent picks a fresh topic each time)",
};

const STATE_CHIP: Record<string, { label: string; cls: string }> = {
  pending: { label: "Awaiting your OK", cls: "bg-cs-gray-soft text-cs-muted" },
  approved: { label: "Approved", cls: "bg-cs-emerald-soft text-emerald-700" },
  skipped: { label: "Skipped", cls: "bg-cs-gray-soft text-cs-light" },
  generating: { label: "Writing…", cls: "bg-cs-accent-soft text-cs-accent-deep animate-pulse" },
  done: { label: "✓ In Drafts", cls: "bg-cs-emerald-soft text-emerald-700" },
  failed: { label: "Failed", cls: "bg-cs-danger-soft text-cs-danger" },
  missed: { label: "Missed", cls: "bg-cs-amber-soft text-amber-700" },
};

function nightLabel(nightOf: string): string {
  const d = new Date(`${nightOf}T00:00:00`);
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

/** Estimated write time: pieces run sequentially from midnight, ~10 min each. */
function estTime(idx: number): string {
  const mins = idx * 10;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hour12 = ((h + 11) % 12) + 1;
  return `≈ ${hour12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

type Setup = {
  format: string;
  step: 1 | 2;
  freq: number;
  source: "pool" | "manual" | "auto" | null;
  manualText: string;
  selected: string[];
  pool: any[];
  poolLoading: boolean;
  researchRunId: string | null;
  saving: boolean;
};

/** Autopilot: per-business overnight drafting. Enabling a content type walks
 *  a two-step setup: frequency → topic source (pick from the suggestion
 *  pool / type your own / fully automatic). */
export default function AutopilotPage() {
  const { activeClientId } = usePortal();
  const [cfg, setCfg] = useState<any | null>(null);
  const [queue, setQueue] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [addText, setAddText] = useState("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!activeClientId) return;
    try {
      const [cfgRes, qRes] = await Promise.all([
        apiFetch("/api/portal/autopilot/config"),
        apiFetch("/api/portal/autopilot/queue"),
      ]);
      const cfgData = await cfgRes.json().catch(() => null);
      const qData = await qRes.json().catch(() => []);
      if (cfgData?.content_types) setCfg(cfgData);
      setQueue(Array.isArray(qData) ? qData : []);
    } catch {
      /* transient */
    }
  }, [activeClientId]);

  useEffect(() => {
    setCfg(null);
    setQueue([]);
    setSetup(null);
    load();
  }, [load]);

  // Refresh the queue every 30s while open (planner fills it asynchronously).
  useEffect(() => {
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const put = async (body: any): Promise<boolean> => {
    setError(null);
    try {
      const res = await apiFetch("/api/portal/autopilot/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(data.detail || `Request failed (${res.status})`));
        return false;
      }
      setCfg(data);
      return true;
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
      return false;
    }
  };

  const putEntry = (format: string, entry: any) =>
    put({ content_types: { ...cfg.content_types, [format]: entry } });

  const setFrequency = (format: string, freq: number) => {
    if (!cfg) return;
    const next = {
      ...cfg,
      content_types: {
        ...cfg.content_types,
        [format]: { ...cfg.content_types[format], frequency_per_week: freq },
      },
    };
    setCfg(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => put({ content_types: next.content_types }), 450);
  };

  // ---- setup flow -------------------------------------------------------- #

  const startSetup = (card: (typeof CARDS)[number]) => {
    const entry = cfg?.content_types?.[card.format];
    setSetup({
      format: card.format,
      step: 1,
      freq: Math.max(1, entry?.frequency_per_week || 1),
      source: null,
      manualText: "",
      selected: [],
      pool: [],
      poolLoading: false,
      researchRunId: null,
      saving: false,
    });
  };

  const loadPool = useCallback(async (format: string) => {
    setSetup((s) => (s && s.format === format ? { ...s, poolLoading: true } : s));
    try {
      const res = await apiFetch(`/api/portal/topic-suggestions?format=${encodeURIComponent(format)}`);
      const data = await res.json().catch(() => []);
      setSetup((s) =>
        s && s.format === format ? { ...s, pool: Array.isArray(data) ? data : [], poolLoading: false } : s
      );
    } catch {
      setSetup((s) => (s && s.format === format ? { ...s, poolLoading: false } : s));
    }
  }, []);

  useEffect(() => {
    if (setup?.step === 2 && setup.source === "pool" && setup.pool.length === 0 && !setup.poolLoading && !setup.researchRunId) {
      loadPool(setup.format);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup?.step, setup?.source]);

  // Poll a research round started from setup.
  useEffect(() => {
    const runId = setup?.researchRunId;
    if (!runId) return;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch("/api/portal/runs");
        const runs = await res.json().catch(() => []);
        const row = Array.isArray(runs) ? runs.find((r: any) => String(r.id) === runId) : null;
        if (!row) return;
        if (row.status === "succeeded") {
          setSetup((s) => (s ? { ...s, researchRunId: null } : s));
          loadPool(setup!.format);
        } else if (row.status === "failed" || row.status === "cancelled") {
          setSetup((s) => (s ? { ...s, researchRunId: null } : s));
          setError("Topic research didn't complete — try again.");
        }
      } catch {
        /* transient */
      }
    }, 5000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setup?.researchRunId]);

  const startResearch = async (card: (typeof CARDS)[number]) => {
    setError(null);
    try {
      const res = await apiFetch("/api/portal/suggest-topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_type: card.content_type, format: card.format, hint: null }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.run_id) setSetup((s) => (s ? { ...s, researchRunId: String(data.run_id) } : s));
      else if (res.status === 409)
        setError("The engine is busy right now — try research again in a few minutes.");
      else setError(String(data.detail || `Request failed (${res.status})`));
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    }
  };

  const saveSetup = async (card: (typeof CARDS)[number]) => {
    if (!setup || !setup.source) return;
    setSetup({ ...setup, saving: true });
    try {
      if (setup.source === "manual") {
        const topics = setup.manualText.split("\n").map((t) => t.trim()).filter(Boolean);
        if (topics.length === 0) {
          setError("Enter at least one topic (one per line).");
          setSetup({ ...setup, saving: false });
          return;
        }
        const res = await apiFetch("/api/portal/autopilot/topics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content_type: card.content_type, format: card.format, topics }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(String(data.detail || `Request failed (${res.status})`));
          setSetup({ ...setup, saving: false });
          return;
        }
      }
      if (setup.source === "pool" && setup.selected.length > 0) {
        await apiFetch("/api/portal/autopilot/topics/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suggestion_ids: setup.selected }),
        });
      }
      const ok = await putEntry(card.format, {
        enabled: true,
        frequency_per_week: setup.freq,
        topic_source: setup.source,
      });
      if (ok) {
        setSetup(null);
        load();
      } else {
        setSetup({ ...setup, saving: false });
      }
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
      setSetup({ ...setup, saving: false });
    }
  };

  const addTopics = async (card: (typeof CARDS)[number]) => {
    const topics = addText.split("\n").map((t) => t.trim()).filter(Boolean);
    if (topics.length === 0) return;
    const res = await apiFetch("/api/portal/autopilot/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content_type: card.content_type, format: card.format, topics }),
    });
    if (res.ok) {
      setAddText("");
      setAddingFor(null);
      load();
    } else {
      const data = await res.json().catch(() => ({}));
      setError(String(data.detail || `Request failed (${res.status})`));
    }
  };

  const queueAction = async (id: string, action: "approve" | "swap" | "skip") => {
    setBusyId(id);
    setError(null);
    try {
      const res = await apiFetch(`/api/portal/autopilot/queue/${encodeURIComponent(id)}/${action}`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(String(data.detail || `Request failed (${res.status})`));
      await load();
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    }
    setBusyId(null);
  };

  const paused = !!cfg?.paused;
  // Per-night execution order for the est-time column (this business's view).
  const nightOrder: Record<string, number> = {};
  {
    const byNight: Record<string, number> = {};
    for (const q of queue) {
      if (!["pending", "approved", "generating"].includes(q.state)) continue;
      byNight[q.night_of] = (byNight[q.night_of] ?? 0) + 1;
      nightOrder[q.id] = byNight[q.night_of] - 1;
    }
  }

  const btn = "rounded-md border px-3.5 py-2 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const btnPrimary = `${btn} border-cs-accent bg-cs-accent text-white hover:bg-cs-accent-hover`;
  const btnGhost = `${btn} border-cs-border-strong bg-white hover:border-cs-light`;

  return (
    <>
      <PageHeader title="Autopilot" subtitle="Set a rhythm — we draft overnight, you review in the morning">
        {cfg && (
          <button
            onClick={() => put({ paused: !paused })}
            className={`${btn} ${
              paused
                ? "border-cs-emerald bg-cs-emerald text-white hover:opacity-90"
                : "border-red-300 bg-white text-cs-danger hover:bg-cs-danger-soft"
            }`}
          >
            {paused ? "▶ Resume autopilot" : "⏸ Pause all autopilot"}
          </button>
        )}
      </PageHeader>

      <div className="max-w-[1200px] px-8 py-6 pb-20">
        <div className="mb-5 flex gap-3 rounded-lg border border-indigo-200 bg-cs-accent-soft px-4 py-3 text-[13px] text-indigo-900">
          <span>ⓘ</span>
          <div>
            Autopilot writes drafts into your Drafts folder <b>overnight (from 12:00 AM)</b> — nothing is
            posted anywhere; you review and approve every piece. Planned topics appear below in advance,
            so you can swap or skip anything until its midnight.
          </div>
        </div>

        {paused && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-cs-amber-soft px-4 py-3 text-[13px] text-amber-800">
            Autopilot is paused for this business — in-flight pieces finish, nothing new gets scheduled.
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-cs-danger-soft px-4 py-3 text-[13px] text-cs-danger">
            {error}
          </div>
        )}

        {!cfg ? (
          <div className="rounded-[10px] border border-cs-border bg-white p-6 text-cs-muted shadow-cs">Loading…</div>
        ) : (
          <>
            {CARDS.map((card) => {
              const entry = cfg.content_types[card.format] ?? { enabled: false, frequency_per_week: 0, topic_source: "pool" };
              const cap = cfg.caps?.[card.format] ?? 1;
              const items = queue.filter((q) => q.format === card.format);
              const inSetup = setup?.format === card.format;
              const on = entry.enabled && !paused;

              return (
                <div
                  key={card.format}
                  className={`mb-3 rounded-[10px] border bg-white p-5 transition-all ${
                    on || inSetup ? "border-cs-accent shadow-cs-md" : "border-cs-border shadow-cs"
                  }`}
                >
                  {/* head */}
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3.5">
                      <div className={`flex h-11 w-11 items-center justify-center rounded-lg text-[15px] font-bold ${
                        on || inSetup ? "bg-cs-accent text-white" : "bg-cs-gray-soft text-cs-muted"
                      }`}>
                        {card.icon}
                      </div>
                      <div>
                        <div className="text-[15px] font-semibold">{card.title}</div>
                        <div className="mt-0.5 text-[12.5px] text-cs-muted">{card.desc}</div>
                      </div>
                    </div>
                    <label className="flex cursor-pointer items-center gap-3">
                      <span className="text-[12.5px] text-cs-muted">{entry.enabled ? <b>On</b> : inSetup ? "Setting up…" : "Off"}</span>
                      <span
                        onClick={() => {
                          if (entry.enabled) putEntry(card.format, { ...entry, enabled: false });
                          else if (inSetup) setSetup(null);
                          else startSetup(card);
                        }}
                        className={`relative inline-block h-[22px] w-10 rounded-full transition-colors ${
                          entry.enabled || inSetup ? "bg-cs-accent" : "bg-cs-border-strong"
                        }`}
                      >
                        <span className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
                          entry.enabled || inSetup ? "left-5" : "left-[2px]"
                        }`} />
                      </span>
                    </label>
                  </div>

                  {/* ---- setup flow ---- */}
                  {inSetup && setup && (
                    <div className="mt-4 border-t border-cs-border pt-4">
                      {setup.step === 1 ? (
                        <>
                          <div className="mb-4 grid grid-cols-2 gap-5">
                            <div>
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                                How often per week?
                              </div>
                              <div className="flex items-center gap-3">
                                <input
                                  type="range" min={1} max={cap} step={1}
                                  value={setup.freq}
                                  onChange={(e) => setSetup({ ...setup, freq: Number(e.target.value) })}
                                  className="flex-1 accent-cs-accent"
                                />
                                <div className="min-w-[30px] text-xl font-bold tracking-[-0.5px]">{setup.freq}</div>
                              </div>
                              <div className="mt-1 text-[11px] text-cs-muted">Max cap: {cap} per week</div>
                            </div>
                            <div>
                              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                                When it writes
                              </div>
                              <div className="text-[13px]">
                                Overnight from <b className="text-cs-accent-deep">12:00 AM ({cfg.timezone})</b>
                              </div>
                              <div className="mt-1 text-[11px] text-cs-muted">
                                Each piece takes ~10 minutes · ready in Drafts by your morning.
                              </div>
                            </div>
                          </div>
                          <div className="flex justify-end gap-2">
                            <button onClick={() => setSetup(null)} className={btnGhost}>Cancel</button>
                            <button onClick={() => setSetup({ ...setup, step: 2 })} className={btnPrimary}>
                              Next: choose topics →
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                            Where should the topics come from?
                          </div>
                          <div className="mb-4 grid grid-cols-3 gap-2.5">
                            {([
                              { id: "pool", title: "Suggest topics", desc: "Pick from researched ideas — the agent researches more when the list runs dry." },
                              { id: "manual", title: "I have topics", desc: "Type your own list — one piece per topic, in your order." },
                              { id: "auto", title: "Fully automatic", desc: "The agent discovers a fresh topic and writes it, in your business voice — zero input." },
                            ] as const).map((opt) => (
                              <button
                                key={opt.id}
                                onClick={() => setSetup({ ...setup, source: opt.id })}
                                className={`rounded-lg border-[1.5px] p-3.5 text-left transition-all ${
                                  setup.source === opt.id
                                    ? "border-cs-accent bg-cs-accent-soft"
                                    : "border-cs-border bg-white hover:border-cs-accent"
                                }`}
                              >
                                <div className="text-[13.5px] font-semibold">{opt.title}</div>
                                <div className="mt-1 text-[12px] leading-[1.45] text-cs-muted">{opt.desc}</div>
                              </button>
                            ))}
                          </div>

                          {setup.source === "pool" && (
                            <div className="mb-4">
                              {setup.poolLoading ? (
                                <div className="text-[13px] text-cs-muted">Loading your topic ideas…</div>
                              ) : setup.researchRunId ? (
                                <div className="animate-pulse rounded-lg border border-cs-accent/40 bg-white px-3.5 py-2.5 text-[13px] text-cs-accent">
                                  ◌ Researching 10 topic ideas — they'll appear here in a couple of minutes…
                                </div>
                              ) : setup.pool.length === 0 ? (
                                <div className="flex items-center justify-between rounded-lg border border-cs-border bg-[#FAFBFC] px-3.5 py-2.5 text-[13px] text-cs-muted">
                                  No topic ideas for this format yet.
                                  <button onClick={() => startResearch(card)} className={btnGhost}>
                                    ✦ Research 10 ideas
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <div className="mb-2 flex items-center justify-between text-[12px] text-cs-muted">
                                    <span>
                                      Tick the topics Autopilot should write ({setup.selected.length} selected) —
                                      they run in order, one per slot.
                                    </span>
                                    <button onClick={() => startResearch(card)} className="underline underline-offset-2 hover:text-cs-text">
                                      ↻ Research more
                                    </button>
                                  </div>
                                  <div className="max-h-52 space-y-1.5 overflow-y-auto pr-1">
                                    {setup.pool.map((s) => {
                                      const id = String(s.id);
                                      const checked = setup.selected.includes(id);
                                      return (
                                        <label
                                          key={id}
                                          className={`flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 ${
                                            checked ? "border-cs-accent bg-cs-accent-soft" : "border-cs-border bg-white hover:border-cs-border-strong"
                                          }`}
                                        >
                                          <input
                                            type="checkbox"
                                            checked={checked}
                                            onChange={() =>
                                              setSetup({
                                                ...setup,
                                                selected: checked
                                                  ? setup.selected.filter((x) => x !== id)
                                                  : [...setup.selected, id],
                                              })
                                            }
                                            className="mt-0.5 accent-cs-accent"
                                          />
                                          <span className="text-[13px] leading-[1.4]">{s.topic}</span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                </>
                              )}
                            </div>
                          )}

                          {setup.source === "manual" && (
                            <div className="mb-4">
                              <textarea
                                value={setup.manualText}
                                onChange={(e) => setSetup({ ...setup, manualText: e.target.value })}
                                rows={6}
                                placeholder={"One topic per line, e.g.\n5 gift ideas for new parents under $40\nHow to plan a wedding registry on a budget\nBack-to-school shopping mistakes to avoid\nBest time to buy winter clothes\nDorm room essentials that are actually worth it"}
                                className="w-full rounded-md border border-cs-border-strong bg-white px-3 py-2.5 text-[13px] outline-none focus:border-cs-accent focus:ring-[3px] focus:ring-cs-accent-soft"
                              />
                              <div className="mt-1 text-[11.5px] text-cs-muted">
                                {setup.manualText.split("\n").filter((t) => t.trim()).length} topic(s) · used in order,
                                one per scheduled slot. Add more anytime.
                              </div>
                            </div>
                          )}

                          {setup.source === "auto" && (
                            <div className="mb-4 rounded-lg border border-cs-border bg-[#FAFBFC] px-3.5 py-3 text-[13px] text-cs-muted">
                              Hands-off mode: on each scheduled night the agent researches, picks the best topic for
                              your business voice, and writes it — exactly like “Discover automatically &amp; generate”.
                              You won't see topics in advance (you can still skip a night), and everything still lands
                              in Drafts for your approval.
                            </div>
                          )}

                          <div className="flex justify-between gap-2">
                            <button onClick={() => setSetup({ ...setup, step: 1 })} className={btnGhost}>← Back</button>
                            <div className="flex gap-2">
                              <button onClick={() => setSetup(null)} className={btnGhost}>Cancel</button>
                              <button
                                onClick={() => saveSetup(card)}
                                disabled={
                                  !setup.source ||
                                  setup.saving ||
                                  (setup.source === "manual" && setup.manualText.split("\n").filter((t) => t.trim()).length === 0)
                                }
                                className={btnPrimary}
                              >
                                {setup.saving ? "Saving…" : "✓ Turn on Autopilot"}
                              </button>
                            </div>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* ---- enabled body ---- */}
                  {entry.enabled && !inSetup && (
                    <div className="mt-4 border-t border-cs-border pt-4">
                      <div className="mb-4 grid grid-cols-3 gap-5">
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                            How often per week?
                          </div>
                          <div className="flex items-center gap-3">
                            <input
                              type="range" min={0} max={cap} step={1}
                              value={entry.frequency_per_week}
                              onChange={(e) => setFrequency(card.format, Number(e.target.value))}
                              className="flex-1 accent-cs-accent"
                            />
                            <div className="min-w-[30px] text-xl font-bold tracking-[-0.5px]">{entry.frequency_per_week}</div>
                          </div>
                          <div className="mt-1 text-[11px] text-cs-muted">Max cap: {cap} per week</div>
                        </div>
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                            When it writes
                          </div>
                          <div className="text-[13px]">
                            Overnight from <b className="text-cs-accent-deep">12:00 AM ({cfg.timezone})</b>
                          </div>
                          <div className="mt-1 text-[11px] text-cs-muted">~10 min per piece · ready by morning.</div>
                        </div>
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                            Topic source
                          </div>
                          <div className="text-[12.5px]">{SOURCE_LABEL[entry.topic_source] ?? entry.topic_source}</div>
                          <div className="mt-1 flex gap-3 text-[11.5px]">
                            <button
                              onClick={() => { startSetup(card); setSetup((s) => (s ? { ...s, step: 2, freq: entry.frequency_per_week || 1 } : s)); }}
                              className="text-cs-accent underline underline-offset-2 hover:text-cs-accent-hover"
                            >
                              Change
                            </button>
                            {entry.topic_source !== "auto" && (
                              <button
                                onClick={() => { setAddingFor(addingFor === card.format ? null : card.format); setAddText(""); }}
                                className="text-cs-accent underline underline-offset-2 hover:text-cs-accent-hover"
                              >
                                {addingFor === card.format ? "Close" : "Add topics"}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>

                      {addingFor === card.format && (
                        <div className="mb-4 rounded-lg border border-cs-border bg-[#FAFBFC] p-3">
                          <textarea
                            value={addText}
                            onChange={(e) => setAddText(e.target.value)}
                            rows={3}
                            placeholder="One topic per line — added to this format's queue pool."
                            className="w-full rounded-md border border-cs-border-strong bg-white px-3 py-2 text-[13px] outline-none focus:border-cs-accent"
                          />
                          <div className="mt-2 flex justify-end">
                            <button onClick={() => addTopics(card)} className={btnPrimary}>Add topics</button>
                          </div>
                        </div>
                      )}

                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                        Planned pieces · swap or skip anything until its midnight
                      </div>
                      {items.length === 0 ? (
                        <div className="rounded-lg border border-cs-border bg-[#FAFBFC] px-3.5 py-2.5 text-[12.5px] text-cs-muted">
                          {entry.topic_source === "manual"
                            ? "Waiting for topics — add some above and slots fill within a minute."
                            : "Planning the coming week — topics appear here within a few minutes (the agent may research fresh ideas first)."}
                        </div>
                      ) : (
                        items.map((q, i) => {
                          const chip = STATE_CHIP[q.state] ?? STATE_CHIP.pending;
                          const actionable = (q.state === "pending" || q.state === "approved");
                          return (
                            <div key={q.id} className="mb-1.5 flex items-center gap-3 rounded-lg border border-cs-border bg-[#FAFBFC] px-3.5 py-2.5">
                              <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-cs-gray-soft text-[11px] font-bold text-cs-muted">
                                {i + 1}
                              </div>
                              <div className={`min-w-0 flex-1 text-[13.5px] ${q.discover ? "italic text-cs-muted" : "font-medium"}`}>
                                {q.topic}
                              </div>
                              <span className={`shrink-0 rounded px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${chip.cls}`}>
                                {chip.label}
                              </span>
                              <div className="shrink-0 text-[11.5px] text-cs-muted">
                                {nightLabel(q.night_of)}
                                {nightOrder[q.id] !== undefined && (
                                  <span className="ml-1 text-cs-light">{estTime(nightOrder[q.id])}</span>
                                )}
                              </div>
                              {actionable && (
                                <div className="flex shrink-0 gap-1">
                                  {q.state !== "approved" && !q.discover && (
                                    <button onClick={() => queueAction(q.id, "approve")} disabled={busyId === q.id}
                                      className="rounded border border-emerald-300 bg-white px-2.5 py-1 text-[11.5px] text-emerald-700 hover:bg-cs-emerald-soft disabled:opacity-50">
                                      Approve
                                    </button>
                                  )}
                                  {!q.discover && (
                                    <button onClick={() => queueAction(q.id, "swap")} disabled={busyId === q.id || (q.swap_count ?? 0) >= 1}
                                      title={(q.swap_count ?? 0) >= 1 ? "Already swapped once" : "Swap for another topic"}
                                      className="rounded border border-cs-border-strong bg-white px-2.5 py-1 text-[11.5px] text-cs-muted hover:text-cs-text disabled:opacity-50">
                                      Swap
                                    </button>
                                  )}
                                  <button onClick={() => queueAction(q.id, "skip")} disabled={busyId === q.id}
                                    className="rounded border border-red-200 bg-white px-2.5 py-1 text-[11.5px] text-cs-danger hover:bg-cs-danger-soft disabled:opacity-50">
                                    Skip
                                  </button>
                                </div>
                              )}
                              {q.note && <div className="shrink-0 text-[11px] text-cs-light" title={q.note}>ⓘ</div>}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <div className="mt-5 flex items-center gap-2 text-[12.5px] text-cs-muted">
              Timezone for the overnight window:
              <select
                value={cfg.timezone}
                onChange={(e) => put({ timezone: e.target.value })}
                className="rounded-md border border-cs-border-strong bg-white px-2 py-1 text-[12.5px] outline-none focus:border-cs-accent"
              >
                {(TIMEZONES.includes(cfg.timezone) ? TIMEZONES : [cfg.timezone, ...TIMEZONES]).map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>
    </>
  );
}
