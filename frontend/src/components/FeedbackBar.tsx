import React, { useState } from "react";
import { apiFetch } from "@/lib/api";

const ACTIONS: { id: "shortlisted" | "approved" | "rejected"; label: string; active: string; idle: string }[] = [
  {
    id: "shortlisted",
    label: "Shortlist",
    active: "bg-cs-amber-soft text-amber-700 border-amber-300",
    idle: "bg-white text-cs-muted border-cs-border-strong hover:text-amber-700 hover:border-amber-300",
  },
  {
    id: "approved",
    label: "Approve",
    active: "bg-cs-emerald-soft text-emerald-700 border-emerald-300",
    idle: "bg-white text-cs-muted border-cs-border-strong hover:text-emerald-700 hover:border-emerald-300",
  },
  {
    id: "rejected",
    label: "Reject",
    active: "bg-cs-danger-soft text-red-700 border-red-300",
    idle: "bg-white text-cs-muted border-cs-border-strong hover:text-red-700 hover:border-red-300",
  },
];

/** Shortlist / approve / reject a package. Events are appended server-side
 *  (package_reviews) and feed the learning loop; the latest event is the
 *  current status, seeded from pkg.feedback merged in by the batch endpoint.
 *  Rendered with key={package_id} so state re-initialises per package. */
export default function FeedbackBar({
  pkg,
  portal = false,
}: {
  pkg: Record<string, any>;
  portal?: boolean;
}) {
  const packageId = pkg.package_id as string | undefined;
  const [status, setStatus] = useState<string | null>(() => (pkg.feedback?.status as string) ?? null);
  const [notes, setNotes] = useState<string>(() => (pkg.feedback?.notes as string) ?? "");
  const [notesOpen, setNotesOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(() => (pkg.feedback?.created_at as string) ?? null);

  if (!packageId) return null;

  const submit = async (action: string) => {
    setPending(action);
    setError(null);
    try {
      const base = portal ? "/api/portal/packages" : "/api/packages";
      const res = await apiFetch(`${base}/${encodeURIComponent(packageId)}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: action, notes: notes.trim() || null }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(data.detail || `Request failed (${res.status})`));
      } else {
        setStatus(data.status ?? action);
        setSavedAt(data.created_at ?? new Date().toISOString());
      }
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="bg-white border border-cs-border rounded-xl p-4 mb-6">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-cs-muted uppercase tracking-wider font-medium">Review</span>
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            onClick={() => {
              if (a.id === "rejected" && !notesOpen) setNotesOpen(true);
              submit(a.id);
            }}
            disabled={pending !== null}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider border transition-all disabled:opacity-50 ${
              status === a.id ? a.active : a.idle
            }`}
          >
            {pending === a.id ? "Saving…" : a.label}
          </button>
        ))}
        <button
          onClick={() => setNotesOpen((v) => !v)}
          className="text-xs text-cs-muted hover:text-cs-text transition-colors underline underline-offset-2"
        >
          {notesOpen ? "Hide notes" : "Add notes"}
        </button>
        {status && savedAt && (
          <span className="text-[10px] text-cs-light ml-auto">
            last: {status} · {new Date(savedAt).toLocaleString()}
          </span>
        )}
      </div>
      {notesOpen && (
        <div className="mt-3">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Optional notes (what worked, what to change) — feeds the learning loop. Saved with your next Shortlist/Approve/Reject click."
            className="w-full bg-white border border-cs-border-strong text-cs-text text-sm rounded-lg focus:ring-cs-accent-soft focus:border-cs-accent p-2.5 outline-none transition-colors"
          />
        </div>
      )}
      {error && <div className="mt-2 text-xs text-cs-danger">{error}</div>}
    </div>
  );
}
