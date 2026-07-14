import React, { useEffect, useState } from "react";
import { apiUrlWithToken } from "@/lib/api";

const TASK_LABELS = [
  "Topic Discovery",
  "Keyword & Competitor Analysis",
  "Drafting Article",
  "Compliance Check",
  "SEO & Quality Check",
  "Assembling Draft Package",
];

export default function TerminalLogs({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [completedTasks, setCompletedTasks] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setCompletedTasks(0);
      setIsFinished(false);
      setHasError(false);
      return;
    }

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
            if (data.text.includes("[AGENT_PROGRESS] Task Completed")) {
              setCompletedTasks((prev) => prev + 1);
            } else if (data.text.toLowerCase().includes("error:") || data.text.toLowerCase().includes("traceback")) {
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

      eventSource.onerror = (err) => {
        setIsFinished(true);
        eventSource?.close();
        setTimeout(() => onClose(), 3000);
      };
    })();

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const currentTaskIndex = Math.min(completedTasks, TASK_LABELS.length - 1);
  const currentTaskLabel = TASK_LABELS[currentTaskIndex];
  const progressPercentage = completedTasks === 0 && !isFinished ? 5 : Math.min((completedTasks / TASK_LABELS.length) * 100, 100);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
      <div className="w-full max-w-2xl bg-gray-950 border border-gray-800 rounded-xl overflow-hidden shadow-2xl p-8">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-gray-200 tracking-wider flex items-center gap-3">
            {!isFinished && !hasError && <span className="w-3 h-3 rounded-full bg-blue-500 animate-pulse"></span>}
            {isFinished ? "Agent Run Completed" : hasError ? "Agent Error Encountered" : "Agent is Running"}
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
            Step {Math.min(completedTasks + 1, TASK_LABELS.length)} of {TASK_LABELS.length}
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
