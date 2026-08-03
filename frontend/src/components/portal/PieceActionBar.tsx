"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";

/** Reject / Shortlist / Approve for one piece. Writes to the existing
 *  feedback event log (reviewer identity comes from the session server-
 *  side). Reject is single-click — no modal (brief §5.4). */
export default function PieceActionBar({
  pieceId,
  state,
  onChanged,
  vertical = false,
}: {
  pieceId: string;
  state: string;
  onChanged: (newState: "shortlisted" | "approved" | "rejected") => void;
  /** Stacked full-width buttons (the Create review side panel). */
  vertical?: boolean;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: "shortlisted" | "approved" | "rejected") => {
    setPending(action);
    setError(null);
    try {
      const res = await apiFetch(`/api/portal/packages/${encodeURIComponent(pieceId)}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: action, notes: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(String(data.detail || `Request failed (${res.status})`));
      } else {
        onChanged(action);
      }
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    }
    setPending(null);
  };

  const base = `inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-[13.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    vertical ? "w-full justify-center" : ""
  }`;

  const approveBtn = (
    <button
      key="approve"
      onClick={() => act("approved")}
      disabled={pending !== null}
      className={`${base} border-cs-accent bg-cs-accent text-white hover:bg-cs-accent-hover`}
    >
      ✓ {pending === "approved" ? "Saving…" : vertical ? "Approve — I'll use this" : "Approve"}
    </button>
  );
  const shortlistBtn = (
    <button
      key="shortlist"
      onClick={() => act("shortlisted")}
      disabled={pending !== null}
      className={`${base} ${
        state === "shortlisted"
          ? "border-cs-amber bg-cs-amber text-white"
          : "border-cs-border-strong bg-white text-cs-text hover:border-cs-amber hover:text-cs-amber"
      }`}
    >
      ★ {pending === "shortlisted" ? "Saving…" : vertical ? "Shortlist — maybe" : "Shortlist"}
    </button>
  );
  const rejectBtn = (
    <button
      key="reject"
      onClick={() => act("rejected")}
      disabled={pending !== null}
      className={`${base} border-red-300 bg-white text-cs-danger hover:bg-cs-danger-soft`}
    >
      ✕ {pending === "rejected" ? "Saving…" : vertical ? "Reject — not this one" : "Reject"}
    </button>
  );

  return (
    <div className={vertical ? "flex flex-col gap-2" : "flex flex-wrap items-center gap-2"}>
      {error && <span className="text-xs text-cs-danger">{error}</span>}
      {vertical ? [approveBtn, shortlistBtn, rejectBtn] : [rejectBtn, shortlistBtn, approveBtn]}
    </div>
  );
}
