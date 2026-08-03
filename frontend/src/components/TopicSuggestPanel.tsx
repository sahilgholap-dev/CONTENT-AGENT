"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type SuggestEndpoints = {
  suggest: string; // POST: start a suggestion round
  list: string; // GET: available suggestions (format=... appended here)
  generate: string; // POST: generate from selected suggestion ids
  runs: string; // GET: run history (polled while a suggestion round runs)
};

/** Suggest-me-topics mode: list existing suggestions for the format, start a
 *  new round (optional taste hint), tick up to maxPerRun topics, generate.
 *  Suggesting stays INSIDE the modal (button animates, list refreshes in
 *  place when the round lands); only Generate hands off to the terminal.
 *  Admin passes clientId; the portal passes null (the JWT scopes it). */
export default function TopicSuggestPanel({
  clientId,
  contentType,
  formatId,
  maxPerRun,
  endpoints,
  onStarted,
}: {
  clientId: string | null;
  contentType: string;
  formatId: string;
  maxPerRun: number;
  endpoints: SuggestEndpoints;
  onStarted: () => void; // close modal + open the run terminal
}) {
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [hint, setHint] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  // Non-null while a suggestion round is running server-side; drives the
  // in-modal button animation + polling.
  const [suggestRunId, setSuggestRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const suggesting = suggestRunId !== null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const sep = endpoints.list.includes("?") ? "&" : "?";
      const res = await apiFetch(`${endpoints.list}${sep}format=${encodeURIComponent(formatId)}`);
      const data = await res.json().catch(() => []);
      setSuggestions(Array.isArray(data) ? data : []);
    } catch {
      setSuggestions([]);
    }
    setLoading(false);
  }, [endpoints.list, formatId]);

  useEffect(() => {
    setSelected([]);
    load();
  }, [load]);

  // Poll the run until the suggestion round lands, then refresh in place.
  useEffect(() => {
    if (!suggestRunId) return;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(endpoints.runs);
        const runs = await res.json().catch(() => []);
        const row = Array.isArray(runs) ? runs.find((r: any) => String(r.id) === suggestRunId) : null;
        if (cancelled || !row) return;
        if (row.status === "succeeded") {
          setSuggestRunId(null);
          load();
        } else if (row.status === "failed" || row.status === "cancelled") {
          setSuggestRunId(null);
          setError(String(row.error || "The topic suggestion run failed — try again."));
        }
      } catch {
        /* transient poll failure: keep polling */
      }
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [suggestRunId, endpoints.runs, load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (maxPerRun === 1) return [id]; // single-piece formats behave like radios
      if (prev.length >= maxPerRun) return prev; // cap reached: ignore the tick
      return [...prev, id];
    });
  };

  const post = async (path: string, body: any) => {
    const res = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  };

  // Suggesting stays in the modal: animate the button, poll, refresh in place.
  const startSuggest = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { res, data } = await post(endpoints.suggest, {
        ...(clientId ? { client_id: clientId } : {}),
        content_type: contentType,
        format: formatId,
        hint: hint.trim() || null,
      });
      if (res.ok && data.run_id) {
        setSuggestRunId(String(data.run_id));
      } else if (res.status === 409) {
        setError("The content engine is busy with another run right now — try again once it finishes.");
      } else {
        setError(String(data.detail || data.error || `Request failed (${res.status})`));
      }
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    }
    setSubmitting(false);
  };

  // Generating hands off to the run terminal, same as the automatic flow.
  const startGenerate = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { res, data } = await post(endpoints.generate, {
        ...(clientId ? { client_id: clientId } : {}),
        suggestion_ids: selected,
      });
      if (res.ok || res.status === 409) {
        onStarted();
        return;
      }
      setError(String(data.detail || data.error || `Request failed (${res.status})`));
      if (res.status === 422) load(); // stale selection: refresh the list
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    }
    setSubmitting(false);
  };

  const inputClass =
    "w-full bg-white border border-cs-border-strong text-cs-text text-sm rounded-lg focus:ring-cs-accent-soft focus:border-cs-accent block p-2.5 outline-none transition-colors";

  return (
    <div className="space-y-3">
      <div>
        <textarea
          className={inputClass + " resize-none"}
          rows={2}
          maxLength={300}
          placeholder="What kind of topics do you have in mind? (optional)"
          value={hint}
          onChange={(e) => setHint(e.target.value)}
        />
        <button
          onClick={startSuggest}
          disabled={submitting || suggesting}
          className={`mt-2 w-full px-4 py-2 bg-white hover:bg-cs-gray-soft disabled:cursor-not-allowed text-cs-text text-sm font-semibold rounded-lg border transition-colors ${
            suggesting ? "border-cs-accent animate-pulse" : "border-cs-border-strong disabled:opacity-50"
          }`}
        >
          {suggesting ? (
            <>
              <span className="inline-block animate-spin mr-2">◌</span>
              Researching topics… you can keep this window open
            </>
          ) : (
            <>
              {suggestions.length > 0 ? "✦ Generate more topics" : "✦ Suggest topics"}
              <span className="text-cs-muted font-normal"> (~2–4 min)</span>
            </>
          )}
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-cs-muted">Loading suggestions…</p>
      ) : suggestions.length === 0 ? (
        <p className="text-sm text-cs-muted">
          {suggesting
            ? "The agent is researching 10 topic ideas — they'll appear right here in a couple of minutes."
            : "No suggestions yet for this format — click “Suggest topics” to get 10 researched ideas."}
        </p>
      ) : (
        <>
          <p className="text-xs text-cs-muted uppercase tracking-wider">
            {maxPerRun === 1 ? "Pick 1 topic" : `Pick up to ${maxPerRun} topics`}
            <span className="float-right font-mono normal-case">
              {selected.length} / {maxPerRun} selected
            </span>
          </p>
          <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
            {suggestions.map((s) => {
              const id = String(s.id);
              const checked = selected.includes(id);
              return (
                <label
                  key={id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    checked ? "border-cs-accent bg-cs-accent/10" : "border-cs-border bg-white hover:border-cs-light"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(id)}
                    className="accent-cs-accent mt-1"
                  />
                  <span>
                    <span className="block text-sm text-cs-text">{s.topic}</span>
                    <span className="block text-xs text-cs-muted mt-1">
                      {s.pillar}
                      {s.rationale ? ` — ${s.rationale}` : ""}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          <button
            onClick={startGenerate}
            disabled={submitting || suggesting || selected.length === 0}
            className="w-full px-5 py-2 bg-cs-accent hover:bg-cs-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-cs-text text-sm font-semibold rounded-lg shadow-lg shadow-cs transition-all border border-cs-accent active:scale-95"
          >
            {submitting ? "Starting…" : `▶ Generate content (${selected.length})`}
          </button>
        </>
      )}

      {error && (
        <div className="p-3 bg-cs-danger-soft border border-red-200 rounded-lg text-cs-danger text-sm">{error}</div>
      )}
    </div>
  );
}
