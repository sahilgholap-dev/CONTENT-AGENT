"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import PageHeader from "@/components/portal/PageHeader";
import { usePortal } from "@/components/portal/PortalShell";

const CARDS = [
  { format: "blog", icon: "B", title: "Blog", desc: "Long-form articles. Higher effort, lower frequency." },
  { format: "linkedin_post", icon: "Li", title: "LinkedIn Post", desc: "Short posts. Best for a steady weekly presence." },
  { format: "youtube_long", icon: "▶", title: "Video Script", desc: "Chaptered YouTube scripts (5–10 minutes)." },
  { format: "youtube_short", icon: "◨", title: "Reel Script", desc: "60–90 second vertical scripts for Shorts and Reels." },
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

/** Autopilot: per-business overnight drafting config. Everything on this
 *  page is scoped to the workspace selected in the sidebar. */
export default function AutopilotPage() {
  const { activeClientId } = usePortal();
  const [cfg, setCfg] = useState<any | null>(null);
  const [queue, setQueue] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
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
    load();
  }, [load]);

  const put = async (body: any) => {
    setError(null);
    try {
      const res = await apiFetch("/api/portal/autopilot/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setError(String(data.detail || `Request failed (${res.status})`));
      else setCfg(data);
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    }
  };

  const setEntry = (format: string, patch: Partial<{ enabled: boolean; frequency_per_week: number }>) => {
    if (!cfg) return;
    const next = {
      ...cfg,
      content_types: {
        ...cfg.content_types,
        [format]: { ...cfg.content_types[format], ...patch },
      },
    };
    setCfg(next); // optimistic; PUT debounced (sliders fire rapidly)
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => put({ content_types: next.content_types }), 450);
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

  return (
    <>
      <PageHeader title="Autopilot" subtitle="Set a rhythm — we draft overnight, you review in the morning">
        {cfg && (
          <button
            onClick={() => put({ paused: !paused })}
            className={`rounded-md border px-3.5 py-2 text-[13px] font-medium transition-colors ${
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
            Autopilot writes drafts into your Drafts folder <b>overnight (from midnight)</b> — nothing is
            posted anywhere; you still review and approve every piece. Planned topics appear below the
            day before, so you can swap or skip anything until midnight.
          </div>
        </div>

        {paused && (
          <div className="mb-5 rounded-lg border border-amber-200 bg-cs-amber-soft px-4 py-3 text-[13px] text-amber-800">
            Autopilot is paused for this business — in-flight pieces finish, nothing new gets scheduled.
            Your toggles below are preserved for when you resume.
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
              const entry = cfg.content_types[card.format] ?? { enabled: false, frequency_per_week: 0 };
              const cap = cfg.caps?.[card.format] ?? 1;
              const items = queue.filter((q) => q.format === card.format);
              const on = entry.enabled && !paused;
              return (
                <div
                  key={card.format}
                  className={`mb-3 rounded-[10px] border bg-white p-5 transition-all ${
                    on ? "border-cs-accent shadow-cs-md" : "border-cs-border shadow-cs"
                  }`}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3.5">
                      <div
                        className={`flex h-11 w-11 items-center justify-center rounded-lg text-[15px] font-bold ${
                          on ? "bg-cs-accent text-white" : "bg-cs-gray-soft text-cs-muted"
                        }`}
                      >
                        {card.icon}
                      </div>
                      <div>
                        <div className="text-[15px] font-semibold">{card.title}</div>
                        <div className="mt-0.5 text-[12.5px] text-cs-muted">{card.desc}</div>
                      </div>
                    </div>
                    <label className="flex cursor-pointer items-center gap-3">
                      <span className="text-[12.5px] text-cs-muted">{entry.enabled ? <b>On</b> : "Off"}</span>
                      <span
                        onClick={() => setEntry(card.format, {
                          enabled: !entry.enabled,
                          frequency_per_week: !entry.enabled && entry.frequency_per_week === 0 ? 1 : entry.frequency_per_week,
                        })}
                        className={`relative inline-block h-[22px] w-10 rounded-full transition-colors ${
                          entry.enabled ? "bg-cs-accent" : "bg-cs-border-strong"
                        }`}
                      >
                        <span
                          className={`absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white shadow transition-all ${
                            entry.enabled ? "left-5" : "left-[2px]"
                          }`}
                        />
                      </span>
                    </label>
                  </div>

                  {entry.enabled && (
                    <div className="mt-4 border-t border-cs-border pt-4">
                      <div className="mb-4 grid grid-cols-2 gap-5">
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                            How often per week?
                          </div>
                          <div className="flex items-center gap-3">
                            <input
                              type="range"
                              min={0}
                              max={cap}
                              step={1}
                              value={entry.frequency_per_week}
                              onChange={(e) => setEntry(card.format, { frequency_per_week: Number(e.target.value) })}
                              className="flex-1 accent-cs-accent"
                            />
                            <div className="min-w-[30px] text-xl font-bold tracking-[-0.5px]">
                              {entry.frequency_per_week}
                            </div>
                          </div>
                          <div className="mt-1 text-[11px] text-cs-muted">Max cap: {cap} per week</div>
                        </div>
                        <div>
                          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                            When it writes
                          </div>
                          <div className="text-[13px]">
                            Overnight from <b className="text-cs-accent-deep">midnight ({cfg.timezone})</b>
                          </div>
                          <div className="mt-1 text-[11px] text-cs-muted">Ready in Drafts by your morning.</div>
                        </div>
                      </div>

                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
                        Planned topics · swap or skip anything until its midnight
                      </div>
                      {items.length === 0 ? (
                        <div className="rounded-lg border border-cs-border bg-[#FAFBFC] px-3.5 py-2.5 text-[12.5px] text-cs-muted">
                          Planning the coming week — topics appear here within a few minutes (the agent may
                          research fresh ideas first).
                        </div>
                      ) : (
                        items.map((q, i) => {
                          const chip = STATE_CHIP[q.state] ?? STATE_CHIP.pending;
                          const actionable = q.state === "pending" || q.state === "approved";
                          return (
                            <div
                              key={q.id}
                              className="mb-1.5 flex items-center gap-3 rounded-lg border border-cs-border bg-[#FAFBFC] px-3.5 py-2.5"
                            >
                              <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-cs-gray-soft text-[11px] font-bold text-cs-muted">
                                {i + 1}
                              </div>
                              <div className="min-w-0 flex-1 text-[13.5px] font-medium">{q.topic}</div>
                              <span className={`shrink-0 rounded px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wide ${chip.cls}`}>
                                {chip.label}
                              </span>
                              <div className="shrink-0 text-[11.5px] text-cs-muted">{nightLabel(q.night_of)}</div>
                              {actionable && (
                                <div className="flex shrink-0 gap-1">
                                  {q.state !== "approved" && (
                                    <button
                                      onClick={() => queueAction(q.id, "approve")}
                                      disabled={busyId === q.id}
                                      className="rounded border border-emerald-300 bg-white px-2.5 py-1 text-[11.5px] text-emerald-700 hover:bg-cs-emerald-soft disabled:opacity-50"
                                    >
                                      Approve
                                    </button>
                                  )}
                                  <button
                                    onClick={() => queueAction(q.id, "swap")}
                                    disabled={busyId === q.id || (q.swap_count ?? 0) >= 1}
                                    title={(q.swap_count ?? 0) >= 1 ? "Already swapped once" : "Swap for another topic"}
                                    className="rounded border border-cs-border-strong bg-white px-2.5 py-1 text-[11.5px] text-cs-muted hover:text-cs-text disabled:opacity-50"
                                  >
                                    Swap
                                  </button>
                                  <button
                                    onClick={() => queueAction(q.id, "skip")}
                                    disabled={busyId === q.id}
                                    className="rounded border border-red-200 bg-white px-2.5 py-1 text-[11.5px] text-cs-danger hover:bg-cs-danger-soft disabled:opacity-50"
                                  >
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
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>
    </>
  );
}
