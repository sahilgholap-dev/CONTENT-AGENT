"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api";

export type SuggestEndpoints = {
  suggest: string; // POST: start a suggestion round
  list: string; // GET: available suggestions (format=... appended here)
  generate: string; // POST: generate from selected suggestion ids
};

/** Suggest-me-topics mode: list existing suggestions for the format, start a
 *  new round (optional taste hint), tick up to maxPerRun topics, generate.
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
  const [error, setError] = useState<string | null>(null);

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

  const toggle = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (maxPerRun === 1) return [id]; // single-piece formats behave like radios
      if (prev.length >= maxPerRun) return prev; // cap reached: ignore the tick
      return [...prev, id];
    });
  };

  const post = async (path: string, body: any) => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
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

  const startSuggest = () =>
    post(endpoints.suggest, {
      ...(clientId ? { client_id: clientId } : {}),
      content_type: contentType,
      format: formatId,
      hint: hint.trim() || null,
    });

  const startGenerate = () =>
    post(endpoints.generate, {
      ...(clientId ? { client_id: clientId } : {}),
      suggestion_ids: selected,
    });

  const inputClass =
    "w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5 outline-none transition-colors";

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
          disabled={submitting}
          className="mt-2 w-full px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-200 text-sm font-semibold rounded-lg border border-gray-700 transition-colors"
        >
          {suggestions.length > 0 ? "✦ Generate more topics" : "✦ Suggest topics"}
          <span className="text-gray-500 font-normal"> (~2–4 min)</span>
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-gray-500">Loading suggestions…</p>
      ) : suggestions.length === 0 ? (
        <p className="text-sm text-gray-500">
          No suggestions yet for this format — click “Suggest topics” to get 10 researched ideas.
        </p>
      ) : (
        <>
          <p className="text-xs text-gray-400 uppercase tracking-wider">
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
                    checked ? "border-blue-500 bg-blue-500/10" : "border-gray-800 bg-gray-900 hover:border-gray-700"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(id)}
                    className="accent-blue-500 mt-1"
                  />
                  <span>
                    <span className="block text-sm text-gray-200">{s.topic}</span>
                    <span className="block text-xs text-gray-500 mt-1">
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
            disabled={submitting || selected.length === 0}
            className="w-full px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-lg shadow-blue-500/20 transition-all border border-blue-400/20 active:scale-95"
          >
            {submitting ? "Starting…" : `▶ Generate content (${selected.length})`}
          </button>
        </>
      )}

      {error && (
        <div className="p-3 bg-red-900/20 border border-red-900/50 rounded-lg text-red-400 text-sm">{error}</div>
      )}
    </div>
  );
}
