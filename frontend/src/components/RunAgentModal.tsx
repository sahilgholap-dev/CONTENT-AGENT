import React, { useState } from "react";
import { apiFetch } from "@/lib/api";
import TopicSuggestPanel from "@/components/TopicSuggestPanel";

/** Client + content-type + format selection before launching a run.
 *  `formats` is the /api/formats registry (content types with nested formats).
 *  Mounted only while open, so state initialises from props on each open. */
export default function RunAgentModal({
  onClose,
  onStarted,
  clients,
  formats,
  defaultClientId,
}: {
  onClose: () => void;
  onStarted: () => void; // opens the terminal
  clients: any[];
  formats: any[];
  defaultClientId: string | null;
}) {
  const activeClients = clients.filter((c) => c.status === "active");
  const [clientId, setClientId] = useState<string>(() => defaultClientId ?? activeClients[0]?.id ?? "");
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
    if (!clientId) {
      setError("Select a client.");
      return;
    }
    const userTopic = topicMode === "user" ? topic.trim() : "";
    if (topicMode === "user" && !userTopic) {
      setError("Enter your topic, or switch back to automatic discovery.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/run-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          content_type: contentType,
          format: formatId,
          topic: userTopic || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      // 409 => already running: still open the terminal to watch it.
      if (res.ok || res.status === 409) {
        onClose();
        onStarted();
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
    "w-full bg-white border border-cs-border-strong text-cs-text text-sm rounded-lg focus:ring-cs-accent-soft focus:border-cs-accent block p-2.5 outline-none transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-6">
      <div className="w-full max-w-md bg-cs-page border border-cs-border rounded-xl shadow-2xl p-8 max-h-[calc(100vh-3rem)] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-cs-text tracking-wider">Run Content Agent</h2>
          <button onClick={onClose} className="text-cs-muted hover:text-cs-text transition-colors text-xl">
            ✕
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-xs text-cs-muted uppercase tracking-wider mb-2">Client</label>
            <select className={selectClass} value={clientId} onChange={(e) => setClientId(e.target.value)}>
              <option value="" disabled>
                Select a client…
              </option>
              {activeClients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.display_name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-cs-muted uppercase tracking-wider mb-2">Content</label>
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
              <p className="text-xs text-cs-muted mt-2">{currentFormat.description}</p>
            )}
          </div>

          <div>
            <label className="block text-xs text-cs-muted uppercase tracking-wider mb-2">Topic Source</label>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm text-cs-text mb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="topic-mode"
                  checked={topicMode === "discover"}
                  onChange={() => setTopicMode("discover")}
                  className="accent-cs-accent"
                />
                Discover automatically &amp; generate
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="topic-mode"
                  checked={topicMode === "suggest"}
                  onChange={() => setTopicMode("suggest")}
                  className="accent-cs-accent"
                />
                Suggest me topics
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="topic-mode"
                  checked={topicMode === "user"}
                  onChange={() => setTopicMode("user")}
                  className="accent-cs-accent"
                />
                I have a topic
              </label>
            </div>
            {topicMode === "suggest" && (
              <TopicSuggestPanel
                clientId={clientId}
                contentType={contentType}
                formatId={formatId}
                maxPerRun={maxPerRun}
                endpoints={{
                  suggest: "/api/suggest-topics",
                  list: `/api/topic-suggestions?client_id=${encodeURIComponent(clientId)}`,
                  generate: "/api/generate-from-suggestions",
                  runs: `/api/runs?client_id=${encodeURIComponent(clientId)}`,
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
                  placeholder="e.g. Litecoin vs Bitcoin withdrawal speeds at US casinos"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                />
                <p className="text-xs text-cs-muted mt-1 flex justify-between">
                  <span>Your exact topic — the agent researches and writes on this, it won't substitute its own.</span>
                  <span className="font-mono">{topic.trim().length}/300</span>
                </p>
              </>
            )}
          </div>

          {error && (
            <div className="p-3 bg-cs-danger-soft border border-red-200 rounded-lg text-cs-danger text-sm">{error}</div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-cs-muted hover:text-cs-text transition-colors"
            >
              Cancel
            </button>
            {topicMode !== "suggest" && (
              <button
                onClick={handleRun}
                disabled={submitting || !clientId || !formatId || (topicMode === "user" && !topic.trim())}
                className="px-5 py-2 bg-cs-accent hover:bg-cs-accent-hover disabled:opacity-50 disabled:cursor-not-allowed text-cs-text text-sm font-semibold rounded-lg shadow-lg shadow-cs transition-all border border-cs-accent active:scale-95"
              >
                {submitting ? "Starting…" : "▶ Run Agent"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
