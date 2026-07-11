import React, { useEffect, useRef, useState } from "react";

export default function TerminalLogs({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [logs, setLogs] = useState<string[]>([]);
  const [isFinished, setIsFinished] = useState(false);
  const endOfLogsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setLogs([]);
      setIsFinished(false);
      return;
    }

    const eventSource = new EventSource("/api/agent-logs");

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.text) {
          setLogs((prev) => [...prev, data.text]);
        }
      } catch (err) {
        console.error("Failed to parse log line", err);
      }
    };

    eventSource.addEventListener("close", () => {
      setIsFinished(true);
      eventSource.close();
    });

    eventSource.onerror = (err) => {
      console.error("EventSource error", err);
      setIsFinished(true);
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, [isOpen]);

  useEffect(() => {
    if (endOfLogsRef.current) {
      endOfLogsRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-6">
      <div className="w-full max-w-5xl h-[80vh] flex flex-col bg-gray-950 border border-gray-800 rounded-xl overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 bg-gray-900 border-b border-gray-800">
          <h2 className="text-sm font-bold text-gray-200 uppercase tracking-wider flex items-center gap-2">
            {!isFinished && <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse"></span>}
            Agent Terminal Logs
            {isFinished && <span className="ml-2 text-xs text-gray-500 bg-gray-800 px-2 py-0.5 rounded-full">(Finished)</span>}
          </h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-white transition-colors text-lg"
          >
            ✕
          </button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 font-mono text-sm text-gray-300">
          {logs.length === 0 && !isFinished ? (
            <div className="text-gray-500 italic">Waiting for logs...</div>
          ) : (
             logs.map((log, idx) => (
              <div key={idx} className="whitespace-pre-wrap break-words">{log}</div>
            ))
          )}
          <div ref={endOfLogsRef} />
        </div>
      </div>
    </div>
  );
}
