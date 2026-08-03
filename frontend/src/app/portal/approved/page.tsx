"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";
import PageHeader from "@/components/portal/PageHeader";
import { usePortal } from "@/components/portal/PortalShell";
import { fmtMeta, pieceClipboardText, timeAgo } from "@/components/portal/pieceMeta";

const FILTERS = ["All", "Blog", "Posts", "Videos", "Reels"];

/** Approved: the client's sign-off library. Immutable pieces with a
 *  per-platform Copy action. (Download + Mark-posted ship later.) */
export default function ApprovedPage() {
  const { activeClientId } = usePortal();
  const [pieces, setPieces] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeClientId) return;
    setLoading(true);
    try {
      const res = await apiFetch("/api/portal/pieces");
      const data = await res.json().catch(() => []);
      setPieces((Array.isArray(data) ? data : []).filter((p) => p.state === "approved"));
    } catch {
      setPieces([]);
    }
    setLoading(false);
  }, [activeClientId]);

  useEffect(() => {
    load();
  }, [load]);

  const copyPiece = async (p: any) => {
    try {
      const res = await apiFetch(`/api/portal/pieces/${encodeURIComponent(p.package_id)}`);
      const detail = await res.json();
      await navigator.clipboard.writeText(pieceClipboardText(detail));
      setCopiedId(p.package_id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      /* clipboard denied or fetch failed — leave the button as-is */
    }
  };

  const visible = pieces.filter(
    (p) =>
      (filter === "All" || fmtMeta(p.format).group === filter) &&
      (!search.trim() || String(p.topic ?? "").toLowerCase().includes(search.trim().toLowerCase()))
  );

  return (
    <>
      <PageHeader title="Approved" subtitle="Pieces you've signed off on · ready to use" />
      <div className="max-w-[1200px] px-8 py-6 pb-20">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full border px-3 py-1 text-[11.5px] font-medium ${
                filter === f
                  ? "border-cs-text bg-cs-text text-white"
                  : "border-cs-border-strong bg-white text-cs-muted hover:text-cs-text"
              }`}
            >
              {f}
            </button>
          ))}
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by title…"
            className="ml-auto w-64 rounded-md border border-cs-border-strong bg-white px-3 py-1.5 text-[13px] outline-none focus:border-cs-accent"
          />
        </div>

        <div className="overflow-hidden rounded-[10px] border border-cs-border bg-white shadow-cs">
          <div className="grid grid-cols-[3px_1fr_130px_120px_150px] items-center gap-3.5 border-b border-cs-border bg-[#FAFBFC] px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-cs-muted">
            <div />
            <div>Piece</div>
            <div>Type</div>
            <div>Approved</div>
            <div />
          </div>

          {loading ? (
            <div className="p-5 text-[13px] text-cs-muted">Loading…</div>
          ) : visible.length === 0 ? (
            <div className="p-5 text-[13px] text-cs-muted">
              Nothing approved yet — approve a draft and it lands here, ready to use.
            </div>
          ) : (
            visible.map((p) => {
              const meta = fmtMeta(p.format);
              return (
                <div
                  key={p.package_id}
                  className="grid grid-cols-[3px_1fr_130px_120px_150px] items-center gap-3.5 border-b border-cs-border px-4 py-3.5 last:border-b-0"
                >
                  <div className="h-full w-[3px] self-stretch rounded-full" style={{ background: meta.color }} />
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-semibold">{p.topic}</div>
                    <div className="text-[11.5px] text-cs-muted">{p.pillar ?? ""}</div>
                  </div>
                  <div>
                    <span className="rounded bg-cs-gray-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider text-cs-muted">
                      {meta.label}
                    </span>
                  </div>
                  <div className="text-[11.5px] text-cs-muted">{timeAgo(p.created_at || p.ingested_at)}</div>
                  <div className="flex justify-end">
                    <button
                      onClick={() => copyPiece(p)}
                      className={`rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors ${
                        copiedId === p.package_id
                          ? "border-cs-emerald bg-cs-emerald-soft text-cs-emerald"
                          : "border-cs-border-strong bg-white hover:border-cs-light"
                      }`}
                    >
                      {copiedId === p.package_id ? "✓ Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
