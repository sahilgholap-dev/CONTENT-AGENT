"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

/** Human-gated learning loop panel (client profile page).
 *  Distill -> pending proposal (editable) -> Accept (new profile version) or
 *  Dismiss. Also shows approval rate per profile version so you can see
 *  whether accepted learnings actually improve outcomes. */
export default function LearningPanel({
  clientId,
  onAccepted,
}: {
  clientId: string;
  onAccepted?: () => void;
}) {
  const [state, setState] = useState<Record<string, any> | null>(null);
  const [editedText, setEditedText] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    apiFetch(`/api/clients/${encodeURIComponent(clientId)}/learning`)
      .then((res) => res.json())
      .then((data) => {
        setState(data);
        setEditedText(data?.pending_proposal?.proposed_text ?? "");
      })
      .catch((err) => console.error("Failed to load learning state", err));
  }, [clientId]);

  useEffect(() => {
    setState(null);
    setMessage(null);
    setError(null);
    load();
  }, [load]);

  const call = async (path: string, body?: Record<string, any>) => {
    setError(null);
    setMessage(null);
    const res = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(data.detail || `Request failed (${res.status})`));
    return data;
  };

  const distill = async () => {
    setBusy("distill");
    try {
      const data = await call(`/api/clients/${encodeURIComponent(clientId)}/learning/distill`);
      if (data.status === "skipped") setMessage(`Nothing to distill: ${data.reason}`);
      else setMessage("New proposal ready for review below.");
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const decide = async (action: "accept" | "dismiss") => {
    const pid = state?.pending_proposal?.id;
    if (!pid) return;
    setBusy(action);
    try {
      const data = await call(
        `/api/clients/${encodeURIComponent(clientId)}/learning/proposals/${pid}/${action}`,
        action === "accept" ? { text: editedText } : undefined
      );
      setMessage(
        action === "accept"
          ? `Accepted — profile v${data.profile_version} created; next runs use the new rules.`
          : "Proposal dismissed. Its events will be re-analysed on the next distill."
      );
      load();
      if (action === "accept") onAccepted?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const proposal = state?.pending_proposal;
  const stats: any[] = state?.stats ?? [];

  return (
    <div className="bg-white border border-cs-border rounded-xl p-5 mb-8">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-bold text-cs-text uppercase tracking-wider">
          Learning Loop
        </h3>
        <span className="text-xs text-cs-muted">
          {state == null
            ? "Loading…"
            : `${state.new_event_count} new review event${state.new_event_count === 1 ? "" : "s"} since last accepted learnings`}
        </span>
        <button
          onClick={distill}
          disabled={busy !== null || state == null}
          className="ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider border bg-indigo-600/20 text-cs-accent-deep border-indigo-500/40 hover:bg-indigo-600 hover:text-cs-text transition-all disabled:opacity-50"
        >
          {busy === "distill" ? "Distilling…" : "Distill learnings"}
        </button>
      </div>

      {message && <div className="mt-3 text-xs text-emerald-600">{message}</div>}
      {error && <div className="mt-3 text-xs text-cs-danger">{error}</div>}

      {proposal && (
        <div className="mt-4 border border-indigo-500/30 rounded-lg p-4 bg-indigo-500/5">
          <div className="text-xs text-cs-muted mb-2">
            Proposed learned-style rules (from {proposal.review_count} review event
            {proposal.review_count === 1 ? "" : "s"}, {new Date(proposal.created_at).toLocaleString()}).
            Edit freely before accepting — accepting creates a new profile version.
          </div>
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            rows={8}
            className="w-full bg-white border border-cs-border-strong text-cs-text text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 p-2.5 outline-none transition-colors font-mono"
          />
          {proposal.current_text ? (
            <details className="mt-2">
              <summary className="text-[11px] text-cs-muted cursor-pointer hover:text-cs-text">
                Show current rules (being replaced)
              </summary>
              <pre className="mt-1 text-[11px] text-cs-muted whitespace-pre-wrap font-mono bg-cs-gray-soft rounded p-2">
                {proposal.current_text}
              </pre>
            </details>
          ) : null}
          <div className="flex gap-3 mt-3">
            <button
              onClick={() => decide("accept")}
              disabled={busy !== null || !editedText.trim()}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider border bg-cs-emerald-soft text-emerald-700 border-emerald-300 hover:bg-green-600 hover:text-cs-text transition-all disabled:opacity-50"
            >
              {busy === "accept" ? "Accepting…" : "Accept → new profile version"}
            </button>
            <button
              onClick={() => decide("dismiss")}
              disabled={busy !== null}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider border bg-white text-cs-muted border-cs-border-strong hover:text-red-700 hover:border-red-300 transition-all disabled:opacity-50"
            >
              {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
            </button>
          </div>
        </div>
      )}

      {stats.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] text-cs-muted uppercase tracking-wider mb-2">
            Approval rate by profile version
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs text-cs-muted w-full">
              <thead>
                <tr className="text-left text-cs-light">
                  <th className="pr-4 py-1 font-medium">Profile</th>
                  <th className="pr-4 py-1 font-medium">Reviewed</th>
                  <th className="pr-4 py-1 font-medium">Approved</th>
                  <th className="pr-4 py-1 font-medium">Rejected</th>
                  <th className="pr-4 py-1 font-medium">Shortlisted</th>
                  <th className="py-1 font-medium">Approval rate</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((s) => (
                  <tr key={s.profile_version} className="border-t border-cs-border">
                    <td className="pr-4 py-1 text-cs-text">v{s.profile_version}</td>
                    <td className="pr-4 py-1">{s.reviewed}</td>
                    <td className="pr-4 py-1 text-emerald-600">{s.approved}</td>
                    <td className="pr-4 py-1 text-cs-danger">{s.rejected}</td>
                    <td className="pr-4 py-1 text-cs-amber">{s.shortlisted}</td>
                    <td className="py-1 text-cs-text">
                      {s.reviewed ? `${Math.round((100 * s.approved) / s.reviewed)}%` : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
