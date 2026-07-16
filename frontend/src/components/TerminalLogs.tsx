import React, { useEffect, useState } from "react";
import { apiUrlWithToken } from "@/lib/api";

// Used only for logs that predate the [AGENT_RUN] header line (legacy runs).
const FALLBACK_LABELS = [
  "Topic Discovery",
  "Keyword & Competitor Analysis",
  "Drafting Article",
  "Compliance Check",
  "SEO & Quality Check",
  "Assembling Draft Package",
];

type RunInfo = {
  client_name?: string;
  format?: string;
  stage_labels?: string[];
};

/** Mounted only while open (the parent renders it conditionally), so state
 *  resets naturally on unmount — no reset effect needed. */
export default function TerminalLogs({ onClose }: { onClose: () => void }) {
  const [completedTasks, setCompletedTasks] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [runInfo, setRunInfo] = useState<RunInfo | null>(null);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let cancelled = false;

    (async () => {
      const url = await apiUrlWithToken("/api/agent-logs");
      if (cancelled) return;
      eventSource = new EventSource(url);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.text) {
            const text: string = data.text;
            if (text.startsWith("[AGENT_RUN] ")) {
              // First log line self-describes the run (client, format, stages).
              try {
                setRunInfo(JSON.parse(text.slice("[AGENT_RUN] ".length)));
              } catch {
                /* malformed header: keep fallback labels */
              }
            } else if (text.includes("[AGENT_PROGRESS] Task Completed")) {
              setCompletedTasks((prev) => prev + 1);
            } else if (text.toLowerCase().includes("error:") || text.toLowerCase().includes("traceback")) {
              setHasError(true);
            }
          }
        } catch (err) {
          console.error("Failed to parse log line", err);
        }
      };

      eventSource.addEventListener("close", () => {
        setIsFinished(true);
        eventSource?.close();
        setTimeout(() => onClose(), 3000);
      });

      eventSource.onerror = () => {
        setIsFinished(true);
        eventSource?.close();
        setTimeout(() => onClose(), 3000);
      };
    })();

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, [onClose]);

  const labels = runInfo?.stage_labels?.length ? runInfo.stage_labels : FALLBACK_LABELS;
  const currentTaskIndex = Math.min(completedTasks, labels.length - 1);
  const currentTaskLabel = labels[currentTaskIndex];
  const progressPercentage =
    completedTasks === 0 && !isFinished ? 5 : Math.min((completedTasks / labels.length) * 100, 100);
  const subtitle = runInfo?.client_name
    ? `${runInfo.client_name}${runInfo.format ? ` — ${runInfo.format}` : ""}`
    : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
      <div className="w-full max-w-2xl bg-gray-950 border border-gray-800 rounded-xl overflow-hidden shadow-2xl p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-gray-200 tracking-wider flex items-center gap-3">
            {!isFinished && !hasError && <span className="w-3 h-3 rounded-full bg-blue-500 animate-pulse"></span>}
            {isFinished ? "Agent Run Completed" : hasError ? "Agent Error Encountered" : "Agent is Running"}
            {subtitle && (
              <span className="text-xs font-medium text-gray-500 normal-case tracking-normal">{subtitle}</span>
            )}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-xl"
          >
            ✕
          </button>
        </div>

        <div className="space-y-6">
          <div className="flex justify-between items-end">
            <div className="text-sm text-gray-400 uppercase tracking-wider">Current Step</div>
            <div className="text-lg font-mono text-blue-400">{isFinished ? "Done" : currentTaskLabel}</div>
          </div>

          <div className="h-4 bg-gray-900 rounded-full overflow-hidden border border-gray-800 relative">
            <div
              className={`h-full transition-all duration-1000 ease-out ${hasError ? 'bg-red-500' : 'bg-blue-500'}`}
              style={{ width: `${isFinished ? 100 : progressPercentage}%` }}
            ></div>
          </div>

          <div className="text-xs text-gray-500 text-right">
            Step {Math.min(completedTasks + 1, labels.length)} of {labels.length}
          </div>

          {hasError && (
             <div className="mt-4 p-4 bg-red-900/20 border border-red-900/50 rounded-lg text-red-400 text-sm">
               An error occurred. Check your local terminal for details.
             </div>
          )}
        </div>
      </div>
    </div>
  );
}
