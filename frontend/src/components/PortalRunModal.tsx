"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import TopicSuggestPanel from "@/components/TopicSuggestPanel";

/** Portal: content-type + format + topic selection before launching a run.
 *  No client picker — the backend scopes the run to the JWT's client_id. */
export default function PortalRunModal({
  onClose,
  onStarted,
  formats,
}: {
  onClose: () => void;
  onStarted: () => void;
  formats: any[];
}) {
  const [contentType, setContentType] = useState<string>(() => formats[0]?.id ?? "");
  const [formatId, setFormatId] = useState<string>(() => formats[0]?.formats?.[0]?.id ?? "");
  const [topicMode, setTopicMode] = useState<"discover" | "suggest" | "user">("discover");
  const [topic, setTopic] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Flat format selection: the user picks the format directly; its parent
  // content type rides along silently (the backend still needs it).
  const allFormats = formats.flatMap((t) => t.formats ?? []);
  const currentFormat = allFormats.find((f: any) => f.id === formatId);
  const maxPerRun = Number(currentFormat?.max_per_run ?? 1);

  const selectFormat = (fid: string) => {
    const parent = formats.find((t) => (t.formats ?? []).some((f: any) => f.id === fid));
    setFormatId(fid);
    setContentType(parent?.id ?? "");
  };

  const handleRun = async () => {
    const userTopic = topicMode === "user" ? topic.trim() : "";
    if (topicMode === "user" && !userTopic) {
      setError("Enter your topic, or switch back to automatic discovery.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/portal/run-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content_type: contentType,
          format: formatId,
          topic: userTopic || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        onClose();
        onStarted();
      } else if (res.status === 409) {
        setError("The content engine is busy with another run right now — please try again in a few minutes.");
        setSubmitting(false);
      } else {
        setError(String(data.detail || data.error || `Request failed (${res.status})`));
        setSubmitting(false);
      }
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
      setSubmitting(false);
    }
  };

  const selectClass =
    "w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5 outline-none transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
      <div className="w-full max-w-md bg-gray-950 border border-gray-800 rounded-xl shadow-2xl p-8 max-h-[calc(100vh-3rem)] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-gray-200 tracking-wider">Generate Content</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors text-xl">
            ✕
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Content</label>
            <select className={selectClass} value={formatId} onChange={(e) => selectFormat(e.target.value)}>
              {formats.map((t) => (
                <optgroup key={t.id} label={t.label}>
                  {(t.formats ?? []).map((f: any) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {currentFormat?.description && (
              <p className="text-xs text-gray-500 mt-2">{currentFormat.description}</p>
            )}
          </div>

          <div>
            <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Topic Source</label>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-gray-300 mb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="portal-topic-mode"
                  checked={topicMode === "discover"}
                  onChange={() => setTopicMode("discover")}
                  className="accent-blue-500"
                />
                Discover automatically &amp; generate
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="portal-topic-mode"
                  checked={topicMode === "suggest"}
                  onChange={() => setTopicMode("suggest")}
                  className="accent-blue-500"
                />
                Suggest me topics
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="portal-topic-mode"
                  checked={topicMode === "user"}
                  onChange={() => setTopicMode("user")}
                  className="accent-blue-500"
                />
                I have a topic
              </label>
            </div>
            {topicMode === "suggest" && (
              <TopicSuggestPanel
                clientId={null}
                contentType={contentType}
                formatId={formatId}
                maxPerRun={maxPerRun}
                endpoints={{
                  suggest: "/api/portal/suggest-topics",
                  list: "/api/portal/topic-suggestions",
                  generate: "/api/portal/generate-from-suggestions",
                  runs: "/api/portal/runs",
                }}
                onStarted={() => {
                  onClose();
                  onStarted();
                }}
              />
            )}
            {topicMode === "user" && (
              <>
                <textarea
                  className={selectClass + " resize-none"}
                  rows={2}
                  maxLength={300}
                  placeholder="Describe the exact topic you want an article about"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                />
                <p className="text-xs text-gray-500 mt-1 flex justify-between">
                  <span>Your exact topic — the agent researches and writes on this.</span>
                  <span className="font-mono">{topic.trim().length}/300</span>
                </p>
              </>
            )}
          </div>

          {error && (
            <div className="p-3 bg-red-900/20 border border-red-900/50 rounded-lg text-red-400 text-sm">{error}</div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            {topicMode !== "suggest" && (
              <button
                onClick={handleRun}
                disabled={submitting || !formatId || (topicMode === "user" && !topic.trim())}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-lg shadow-blue-500/20 transition-all border border-blue-400/20 active:scale-95"
              >
                {submitting ? "Starting…" : "▶ Generate"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
