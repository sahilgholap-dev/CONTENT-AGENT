"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import PageHeader from "@/components/portal/PageHeader";
import PieceActionBar from "@/components/portal/PieceActionBar";
import PieceReviewPane from "@/components/portal/PieceReviewPane";
import { usePortal } from "@/components/portal/PortalShell";
import { fmtMeta, timeAgo } from "@/components/portal/pieceMeta";

const FILTERS = ["All", "Autopilot", "Blog", "Posts", "Videos", "Reels"];

/** Drafts: two-pane review queue. Left = draft cards (drafted+shortlisted),
 *  right = the selected piece with Reject/Shortlist/Approve. Bulk mode
 *  reveals checkboxes + a bulk action bar. */
export default function DraftsView({ initialId }: { initialId?: string }) {
  const { activeClientId } = usePortal();
  const [pieces, setPieces] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? null);
  const [detail, setDetail] = useState<any | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState("All");
  const [bulk, setBulk] = useState(false);
  const [checked, setChecked] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);

  const load = useCallback(async () => {
    if (!activeClientId) return;
    setLoading(true);
    try {
      const res = await apiFetch("/api/portal/pieces");
      const data = await res.json().catch(() => []);
      const drafts = (Array.isArray(data) ? data : []).filter(
        (p) => p.state === "drafted" || p.state === "shortlisted"
      );
      setPieces(drafts);
      setSelectedId((prev) =>
        prev && drafts.some((p) => p.package_id === prev) ? prev : drafts[0]?.package_id ?? null
      );
    } catch {
      setPieces([]);
    }
    setLoading(false);
  }, [activeClientId]);

  useEffect(() => {
    setChecked([]);
    load();
  }, [load]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    apiFetch(`/api/portal/pieces/${encodeURIComponent(selectedId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setDetail(data?.package_id ? data : null);
      })
      .catch(() => !cancelled && setDetail(null))
      .finally(() => !cancelled && setDetailLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const visible = pieces.filter((p) =>
    filter === "All"
      ? true
      : filter === "Autopilot"
        ? p.origin === "autopilot"
        : fmtMeta(p.format).group === filter
  );
  const autopilotCount = pieces.filter((p) => p.origin === "autopilot").length;

  const handleStateChange = (id: string, newState: string) => {
    if (newState === "shortlisted") {
      setPieces((prev) => prev.map((p) => (p.package_id === id ? { ...p, state: "shortlisted" } : p)));
      setDetail((d: any) => (d && d.package_id === id ? { ...d, state: "shortlisted" } : d));
      return;
    }
    // approved / rejected leave the Drafts list
    setPieces((prev) => {
      const rest = prev.filter((p) => p.package_id !== id);
      setSelectedId((sel) => (sel === id ? rest[0]?.package_id ?? null : sel));
      return rest;
    });
  };

  const bulkAct = async (action: "approved" | "rejected") => {
    setBulkBusy(true);
    for (const id of checked) {
      try {
        await apiFetch(`/api/portal/packages/${encodeURIComponent(id)}/feedback`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: action, notes: null }),
        });
      } catch {
        /* keep going; the reload shows the truth */
      }
    }
    setChecked([]);
    setBulk(false);
    setBulkBusy(false);
    load();
  };

  return (
    <>
      <PageHeader
        title="Drafts"
        subtitle={
          loading
            ? "Loading your pieces…"
            : `${pieces.length} piece${pieces.length === 1 ? "" : "s"} waiting for your review${
                autopilotCount > 0 ? ` · ${autopilotCount} from Autopilot` : ""
              }`
        }
      >
        <button
          onClick={() => {
            setBulk((v) => !v);
            setChecked([]);
          }}
          className="rounded-md border border-cs-border-strong bg-white px-3.5 py-2 text-[13px] font-medium hover:border-cs-light"
        >
          {bulk ? "Done selecting" : "Select multiple"}
        </button>
        <Link
          href="/portal/create"
          className="rounded-md border border-cs-accent bg-cs-accent px-3.5 py-2 text-[13px] font-medium text-white hover:bg-cs-accent-hover"
        >
          ＋ Create new
        </Link>
      </PageHeader>

      <div className="max-w-[1200px] px-8 py-6 pb-20">
        {bulk && (
          <div className="mb-4 flex items-center justify-between rounded-[10px] border border-cs-accent bg-cs-accent-soft px-4 py-3 text-[13px] text-cs-accent-deep">
            <span>
              {checked.length} selected — bulk actions apply to every ticked draft.
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => bulkAct("rejected")}
                disabled={bulkBusy || checked.length === 0}
                className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-[12.5px] font-medium text-cs-danger hover:bg-cs-danger-soft disabled:opacity-50"
              >
                Reject selected
              </button>
              <button
                onClick={() => bulkAct("approved")}
                disabled={bulkBusy || checked.length === 0}
                className="rounded-md border border-cs-accent bg-cs-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-cs-accent-hover disabled:opacity-50"
              >
                {bulkBusy ? "Working…" : "Approve selected"}
              </button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-[380px_1fr] items-start gap-5">
          {/* Left: list */}
          <div className="overflow-hidden rounded-[10px] border border-cs-border bg-white shadow-cs">
            <div className="flex flex-wrap gap-1.5 border-b border-cs-border bg-[#FAFBFC] p-3">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`rounded-full border px-2.5 py-1 text-[11.5px] font-medium ${
                    filter === f
                      ? "border-cs-text bg-cs-text text-white"
                      : "border-cs-border-strong bg-white text-cs-muted hover:text-cs-text"
                  }`}
                >
                  {f === "All" ? `All ${pieces.length}` : f}
                </button>
              ))}
            </div>

            {loading ? (
              <div className="p-5 text-[13px] text-cs-muted">Loading…</div>
            ) : visible.length === 0 ? (
              <div className="p-5 text-[13px] text-cs-muted">
                Nothing waiting for review{filter !== "All" ? ` under ${filter}` : ""} — create a
                piece and it lands here.
              </div>
            ) : (
              visible.map((p) => {
                const meta = fmtMeta(p.format);
                const selected = p.package_id === selectedId;
                return (
                  <div
                    key={p.package_id}
                    onClick={() => setSelectedId(p.package_id)}
                    className={`flex cursor-pointer items-start gap-3 border-b border-cs-border px-4 py-3.5 last:border-b-0 ${
                      selected ? "bg-cs-accent-soft" : "hover:bg-[#FAFBFC]"
                    }`}
                  >
                    {bulk && (
                      <input
                        type="checkbox"
                        checked={checked.includes(p.package_id)}
                        onChange={(e) => {
                          e.stopPropagation();
                          setChecked((prev) =>
                            prev.includes(p.package_id)
                              ? prev.filter((x) => x !== p.package_id)
                              : [...prev, p.package_id]
                          );
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 accent-cs-accent"
                      />
                    )}
                    <div
                      className="w-[3px] self-stretch rounded-full"
                      style={{ background: meta.color }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="mb-1 text-[13.5px] font-semibold leading-[1.35]">
                        {p.topic}
                        {p.state === "shortlisted" && (
                          <span className="ml-1.5 text-cs-amber" title="Shortlisted">
                            ★
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-cs-muted">
                        <span className="rounded bg-cs-gray-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider">
                          {meta.label}
                        </span>
                        {p.origin === "autopilot" && (
                          <span className="rounded bg-cs-emerald-soft px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-emerald-700">
                            ⟳ Autopilot
                          </span>
                        )}
                        <span>{timeAgo(p.created_at || p.ingested_at)}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Right: the piece */}
          <div>
            {detailLoading ? (
              <div className="rounded-xl border border-cs-border bg-white p-10 text-center text-cs-muted shadow-cs">
                Loading piece…
              </div>
            ) : detail ? (
              <PieceReviewPane
                piece={detail}
                footer={
                  <PieceActionBar
                    pieceId={detail.package_id}
                    state={detail.state}
                    onChanged={(st) => handleStateChange(detail.package_id, st)}
                  />
                }
              />
            ) : (
              <div className="rounded-xl border border-cs-border bg-white p-10 text-center text-cs-muted shadow-cs">
                {pieces.length === 0 && !loading
                  ? "All caught up — nothing waiting for review."
                  : "Select a draft on the left."}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
