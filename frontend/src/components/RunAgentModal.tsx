import React, { useState } from "react";
import { apiFetch } from "@/lib/api";

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
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const currentType = formats.find((t) => t.id === contentType);
  const typeFormats = currentType?.formats ?? [];

  const handleRun = async () => {
    if (!clientId) {
      setError("Select a client.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch("/api/run-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, content_type: contentType, format: formatId }),
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
    "w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5 outline-none transition-colors";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
      <div className="w-full max-w-md bg-gray-950 border border-gray-800 rounded-xl overflow-hidden shadow-2xl p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-gray-200 tracking-wider">Run Content Agent</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors text-xl">
            ✕
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Client</label>
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
            <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Content Type</label>
            <select
              className={selectClass}
              value={contentType}
              onChange={(e) => {
                const t = formats.find((x) => x.id === e.target.value);
                setContentType(e.target.value);
                setFormatId(t?.formats?.[0]?.id ?? "");
              }}
            >
              {formats.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs text-gray-400 uppercase tracking-wider mb-2">Format</label>
            <select className={selectClass} value={formatId} onChange={(e) => setFormatId(e.target.value)}>
              {typeFormats.map((f: any) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            {typeFormats.find((f: any) => f.id === formatId)?.description && (
              <p className="text-xs text-gray-500 mt-2">
                {typeFormats.find((f: any) => f.id === formatId).description}
              </p>
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
            <button
              onClick={handleRun}
              disabled={submitting || !clientId || !formatId}
              className="px-5 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-lg shadow-blue-500/20 transition-all border border-blue-400/20 active:scale-95"
            >
              {submitting ? "Starting…" : "▶ Run Agent"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
