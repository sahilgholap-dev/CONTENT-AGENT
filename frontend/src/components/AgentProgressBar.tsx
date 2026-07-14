import React, { useEffect, useState } from "react";
import { apiUrlWithToken } from "@/lib/api";

const STEPS = [
  "Initializing...",
  "Discovering Topics",
  "Researching & Grounding",
  "Drafting Content",
  "Compliance Check",
  "SEO & Quality Check",
  "Assembling Package",
  "Saving & Generating Images...",
  "Finished!"
];

export default function AgentProgressBar({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [currentStep, setCurrentStep] = useState(0);
  const [isFinished, setIsFinished] = useState(false);

  useEffect(() => {
    if (!isOpen) {
      setCurrentStep(0);
      setIsFinished(false);
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
            const line = data.text.toLowerCase();
            if (line.includes("task: discover exactly")) {
              setCurrentStep(1);
            } else if (line.includes("task: perform layer a research")) {
              setCurrentStep(2);
            } else if (line.includes("task: write full casino article")) {
              setCurrentStep(3);
            } else if (line.includes("task: run the compliance mandate")) {
              setCurrentStep(4);
            } else if (line.includes("task: run the seo and quality gate")) {
              setCurrentStep(5);
            } else if (line.includes("task: assemble 1 complete draft")) {
              setCurrentStep(6);
            } else if (line.includes("[storage] saved batch")) {
              setCurrentStep(7);
            }
          }
        } catch (err) {
          console.error("Failed to parse log line", err);
        }
      };

      eventSource.addEventListener("close", () => {
        setCurrentStep(8);
        setIsFinished(true);
        eventSource?.close();
      });

      eventSource.onerror = (err) => {
        setCurrentStep(8);
        setIsFinished(true);
        eventSource?.close();
      };
    })();

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const progressPercentage = (currentStep / (STEPS.length - 1)) * 100;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
      <div className="w-full max-w-2xl bg-gray-950 border border-gray-800 rounded-xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800">
          <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider flex items-center gap-2">
            {!isFinished && <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>}
            Content Engine Progress
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-lg"
          >
            ✕
          </button>
        </div>
        
        <div className="p-8">
          <div className="mb-4 flex justify-between items-end">
            <div>
              <div className="text-xs text-gray-500 uppercase tracking-wider mb-1">Current Step</div>
              <div className="text-xl font-semibold text-blue-400">
                {STEPS[currentStep]}
              </div>
            </div>
            <div className="text-2xl font-bold text-gray-700">
              {Math.round(progressPercentage)}%
            </div>
          </div>
          
          <div className="h-3 w-full bg-gray-800 rounded-full overflow-hidden">
            <div 
              className="h-full bg-gradient-to-r from-blue-600 to-indigo-500 transition-all duration-500 ease-out"
              style={{ width: `${progressPercentage}%` }}
            />
          </div>
          
          <div className="mt-8 space-y-3">
            {STEPS.map((step, idx) => {
              const isPast = idx < currentStep;
              const isCurrent = idx === currentStep;
              return (
                <div key={idx} className={`flex items-center gap-3 text-sm transition-colors duration-300 ${isPast ? "text-gray-500" : isCurrent ? "text-gray-200" : "text-gray-700"}`}>
                  <div className={`w-4 h-4 rounded-full flex items-center justify-center border ${isPast ? "bg-gray-800 border-gray-700" : isCurrent ? "bg-blue-500 border-blue-400 shadow-[0_0_10px_rgba(59,130,246,0.5)]" : "border-gray-800"}`}>
                    {isPast && <span className="text-[10px] text-gray-400">✓</span>}
                    {isCurrent && !isFinished && <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" />}
                  </div>
                  <span className={isCurrent ? "font-medium" : ""}>{step}</span>
                </div>
              );
            })}
          </div>
          
          {isFinished && (
            <div className="mt-8 p-4 bg-green-500/10 border border-green-500/20 rounded-lg text-center">
              <p className="text-green-400 font-medium">Batch generated successfully!</p>
              <p className="text-xs text-green-500/70 mt-1">You can close this window and view the new batch in the sidebar.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
