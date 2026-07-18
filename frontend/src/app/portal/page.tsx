"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BatchViewer from "@/components/BatchViewer";
import PortalRunModal from "@/components/PortalRunModal";
import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

const ACTIVE_STATUSES = new Set(["queued", "running", "started"]);

/** Client portal home: their batches only (scoped server-side by the JWT's
 *  client_id), with the standard batch viewer in portal mode. Clients can
 *  launch runs for their own business and review the drafts. */
export default function PortalDashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Record<string, any> | null>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [formats, setFormats] = useState<any[]>([]);
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  const [activeRun, setActiveRun] = useState<Record<string, any> | null>(null);
  const [progress, setProgress] = useState<Record<string, any> | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(() => {
    apiFetch("/api/portal/me")
      .then((res) => res.json())
      .then((data) => data?.id && setMe(data))
      .catch(() => {});
    apiFetch("/api/portal/batches")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setBatches(data);
          setSelectedBatchId((prev) => prev ?? (data.length > 0 ? data[0].id : null));
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    apiFetch("/api/portal/formats")
      .then((res) => res.json())
      .then((data) => Array.isArray(data?.content_types) && setFormats(data.content_types))
      .catch(() => {});
  }, [load]);

  // Poll run status: while a run is active, check every 10s; when it leaves
  // the active set, refresh the batch list so the new content appears.
  const checkRuns = useCallback(() => {
    apiFetch("/api/portal/runs")
      .then((res) => res.json())
      .then((runs) => {
        if (!Array.isArray(runs)) return;
        const active = runs.find((r) => ACTIVE_STATUSES.has(String(r.status)));
        setActiveRun(active ?? null);
        if (active) {
          wasRunning.current = true;
        } else if (wasRunning.current) {
          wasRunning.current = false;
          const latest = runs[0];
          setRunNotice(
            latest?.status === "failed"
              ? "The last content run did not complete — our team has been notified. Please try again later."
              : "Your new content is ready below."
          );
          load();
        }
      })
      .catch(() => {});
  }, [load]);

  useEffect(() => {
    checkRuns();
    const timer = setInterval(checkRuns, 10_000);
    return () => clearInterval(timer);
  }, [checkRuns]);

  // While a run is active, poll stage progress (server-side parsed, scoped to
  // this client's run) every 5s to drive the progress bar.
  useEffect(() => {
    if (!activeRun) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      apiFetch("/api/portal/run-progress")
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled && data && typeof data.total === "number") setProgress(data);
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeRun]);

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-gray-950">
      {/* Left: batch list */}
      <div className="w-full md:w-80 bg-gray-900/50 backdrop-blur-md border-b md:border-b-0 md:border-r border-gray-800 flex flex-col max-h-[45vh] md:max-h-none md:h-full shrink-0">
        <div className="p-6 border-b border-gray-800">
          <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
            {me?.display_name ?? "Content Portal"}
          </h1>
          <p className="text-xs text-gray-500 mt-1">{me?.site_domain ?? ""}</p>
          <div className="flex justify-between items-center mt-3">
            <p className="text-xs text-gray-400 uppercase tracking-wider">Your Content</p>
            <div className="flex items-center gap-2">
              <Link
                href="/portal/account"
                className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 bg-gray-800 text-gray-400 border border-gray-700 rounded hover:text-gray-200 hover:border-gray-500 transition-colors"
              >
                Account
              </Link>
              <button
                onClick={handleSignOut}
                className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 bg-gray-800 text-gray-400 border border-gray-700 rounded hover:text-red-300 hover:border-red-500/40 transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>

          <button
            onClick={() => setIsRunModalOpen(true)}
            disabled={!!activeRun || formats.length === 0}
            className="mt-3 w-full px-3 py-2 bg-blue-600/20 text-blue-400 border border-blue-500/30 rounded-lg text-xs uppercase font-bold tracking-wider hover:bg-blue-600 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {activeRun ? "Generating…" : "▶ Generate Content"}
          </button>

          {activeRun && (
            <div className="mt-2">
              <div className="flex items-center gap-2 text-[11px] text-blue-300">
                <span className="inline-block h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
                {progress?.label
                  ? `${progress.label}…`
                  : `Content run in progress (${activeRun.format ?? "article"})`}
              </div>
              <div className="mt-2 h-1.5 w-full rounded-full bg-gray-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-blue-500 transition-all duration-700"
                  style={{
                    width: progress && progress.total
                      ? `${Math.max(6, Math.round((100 * progress.stage) / progress.total))}%`
                      : "6%",
                  }}
                />
              </div>
              <div className="mt-1 flex justify-between text-[10px] text-gray-500">
                <span>
                  {progress && progress.total
                    ? `Step ${Math.min(progress.stage + 1, progress.total)} of ${progress.total}`
                    : "Starting…"}
                </span>
                <span>New drafts appear automatically</span>
              </div>
            </div>
          )}
          {runNotice && !activeRun && (
            <div className="mt-2 flex items-start justify-between gap-2 text-[11px] text-green-300">
              <span>{runNotice}</span>
              <button onClick={() => setRunNotice(null)} className="text-gray-500 hover:text-gray-300">
                ✕
              </button>
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="text-gray-500 text-sm p-2 animate-pulse">Loading…</div>
          ) : batches.length === 0 ? (
            <div className="text-gray-500 text-sm p-2">
              No content yet — new batches appear here as soon as they're produced.
            </div>
          ) : (
            batches.map((b) => {
              const isSelected = b.id === selectedBatchId;
              return (
                <button
                  key={b.id}
                  onClick={() => setSelectedBatchId(b.id)}
                  className={`w-full text-left p-4 rounded-xl transition-all duration-200 border ${
                    isSelected
                      ? "bg-blue-600/10 border-blue-500/50"
                      : "bg-gray-800/30 border-transparent hover:bg-gray-800/80 hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-semibold ${isSelected ? "text-blue-400" : "text-gray-200"}`}>
                      {b.batch_date}
                    </span>
                    {b.format && (
                      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">
                        {b.format}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {b.package_count ?? b.total_packages ?? 0} article
                    {(b.package_count ?? b.total_packages ?? 0) === 1 ? "" : "s"}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right: batch viewer (portal mode — no Raw JSON, scoped API) */}
      <main className="flex-1 min-w-0 min-h-0 overflow-hidden">
        {selectedBatchId != null ? (
          <BatchViewer batchId={selectedBatchId} portal />
        ) : loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-gray-500">
            {batches.length === 0 ? "" : "Select a batch on the left."}
          </div>
        )}
      </main>

      {isRunModalOpen && (
        <PortalRunModal
          onClose={() => setIsRunModalOpen(false)}
          onStarted={() => {
            setRunNotice(null);
            checkRuns();
          }}
          formats={formats}
        />
      )}
    </div>
  );
}
