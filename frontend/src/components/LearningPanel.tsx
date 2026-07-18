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
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 mb-8">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-bold text-gray-200 uppercase tracking-wider">
          Learning Loop
        </h3>
        <span className="text-xs text-gray-500">
          {state == null
            ? "Loading…"
            : `${state.new_event_count} new review event${state.new_event_count === 1 ? "" : "s"} since last accepted learnings`}
        </span>
        <button
          onClick={distill}
          disabled={busy !== null || state == null}
          className="ml-auto px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider border bg-indigo-600/20 text-indigo-300 border-indigo-500/40 hover:bg-indigo-600 hover:text-white transition-all disabled:opacity-50"
        >
          {busy === "distill" ? "Distilling…" : "Distill learnings"}
        </button>
      </div>

      {message && <div className="mt-3 text-xs text-green-400">{message}</div>}
      {error && <div className="mt-3 text-xs text-red-400">{error}</div>}

      {proposal && (
        <div className="mt-4 border border-indigo-500/30 rounded-lg p-4 bg-indigo-500/5">
          <div className="text-xs text-gray-400 mb-2">
            Proposed learned-style rules (from {proposal.review_count} review event
            {proposal.review_count === 1 ? "" : "s"}, {new Date(proposal.created_at).toLocaleString()}).
            Edit freely before accepting — accepting creates a new profile version.
          </div>
          <textarea
            value={editedText}
            onChange={(e) => setEditedText(e.target.value)}
            rows={8}
            className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-indigo-500 focus:border-indigo-500 p-2.5 outline-none transition-colors font-mono"
          />
          {proposal.current_text ? (
            <details className="mt-2">
              <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-300">
                Show current rules (being replaced)
              </summary>
              <pre className="mt-1 text-[11px] text-gray-500 whitespace-pre-wrap font-mono bg-gray-800/50 rounded p-2">
                {proposal.current_text}
              </pre>
            </details>
          ) : null}
          <div className="flex gap-3 mt-3">
            <button
              onClick={() => decide("accept")}
              disabled={busy !== null || !editedText.trim()}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider border bg-green-500/20 text-green-300 border-green-500/40 hover:bg-green-600 hover:text-white transition-all disabled:opacity-50"
            >
              {busy === "accept" ? "Accepting…" : "Accept → new profile version"}
            </button>
            <button
              onClick={() => decide("dismiss")}
              disabled={busy !== null}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold uppercase tracking-wider border bg-gray-800 text-gray-400 border-gray-700 hover:text-red-300 hover:border-red-500/40 transition-all disabled:opacity-50"
            >
              {busy === "dismiss" ? "Dismissing…" : "Dismiss"}
            </button>
          </div>
        </div>
      )}

      {stats.length > 0 && (
        <div className="mt-4">
          <div className="text-[11px] text-gray-500 uppercase tracking-wider mb-2">
            Approval rate by profile version
          </div>
          <div className="overflow-x-auto">
            <table className="text-xs text-gray-400 w-full">
              <thead>
                <tr className="text-left text-gray-600">
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
                  <tr key={s.profile_version} className="border-t border-gray-800">
                    <td className="pr-4 py-1 text-gray-300">v{s.profile_version}</td>
                    <td className="pr-4 py-1">{s.reviewed}</td>
                    <td className="pr-4 py-1 text-green-400">{s.approved}</td>
                    <td className="pr-4 py-1 text-red-400">{s.rejected}</td>
                    <td className="pr-4 py-1 text-yellow-400">{s.shortlisted}</td>
                    <td className="py-1 text-gray-300">
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
