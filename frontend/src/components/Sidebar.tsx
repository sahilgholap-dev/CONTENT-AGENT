import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import TerminalLogs from "./TerminalLogs";
import RunAgentModal from "./RunAgentModal";
import { createClient } from "@/lib/supabase/client";

export default function Sidebar({
  batches,
  selectedBatchId,
  onSelectBatch,
  loading,
  clients,
  formats,
  selectedClientId,
  onSelectClient,
  onRunStarted,
}: {
  batches: any[];
  selectedBatchId: number | null;
  onSelectBatch: (id: number) => void;
  loading: boolean;
  clients: any[];
  formats: any[];
  selectedClientId: string | null;
  onSelectClient: (clientId: string | null) => void;
  onRunStarted: () => void;
}) {
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isRunModalOpen, setIsRunModalOpen] = useState(false);
  const router = useRouter();

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <>
      <div className="w-80 bg-gray-900/50 backdrop-blur-md border-r border-gray-800 flex flex-col h-full shrink-0">
      <div className="p-6 border-b border-gray-800">
        <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
          Content Engine
        </h1>

        <div className="mt-3 flex items-center gap-2">
          <select
            className="flex-1 bg-gray-800 border border-gray-700 text-gray-200 text-xs rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2 outline-none transition-colors"
            value={selectedClientId ?? "__all__"}
            onChange={(e) => onSelectClient(e.target.value === "__all__" ? null : e.target.value)}
          >
            <option value="__all__">All clients</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name}
                {c.status !== "active" ? ` (${c.status})` : ""}
              </option>
            ))}
          </select>
          <Link
            href="/admin/clients"
            className="text-[10px] uppercase font-bold tracking-wider px-2 py-2 bg-gray-800 text-gray-400 border border-gray-700 rounded hover:text-gray-200 hover:border-gray-500 transition-colors"
            title="Manage clients"
          >
            Clients
          </Link>
          <Link
            href="/admin/registry"
            className="text-[10px] uppercase font-bold tracking-wider px-2 py-2 bg-gray-800 text-gray-400 border border-gray-700 rounded hover:text-gray-200 hover:border-gray-500 transition-colors"
            title="Manage content types & formats"
          >
            Formats
          </Link>
          <Link
            href="/admin/users"
            className="text-[10px] uppercase font-bold tracking-wider px-2 py-2 bg-gray-800 text-gray-400 border border-gray-700 rounded hover:text-gray-200 hover:border-gray-500 transition-colors"
            title="Manage portal logins"
          >
            Users
          </Link>
        </div>

        <div className="flex justify-between items-center mt-3">
          <p className="text-xs text-gray-400 uppercase tracking-wider">
            Batch Viewer
          </p>
          <button
            onClick={() => setIsRunModalOpen(true)}
            className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 bg-blue-600/20 text-blue-400 border border-blue-500/30 rounded hover:bg-blue-600 hover:text-white transition-colors"
          >
            ▶ Run Agent
          </button>
        </div>
        <button
          onClick={handleSignOut}
          className="mt-3 text-[10px] uppercase font-bold tracking-wider text-gray-500 hover:text-gray-300 transition-colors"
        >
          Sign out
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <div className="text-gray-500 text-sm p-2 animate-pulse">Loading...</div>
        ) : batches.length === 0 ? (
          <div className="text-gray-500 text-sm p-2">No batches found</div>
        ) : (
          batches.map((batch) => {
            const isSelected = batch.id === selectedBatchId;
            const dateStr = batch.ingested_at
              ? new Date(batch.ingested_at).toLocaleString()
              : "Unknown Date";

            return (
              <button
                key={batch.id}
                onClick={() => onSelectBatch(batch.id)}
                className={`w-full text-left p-4 rounded-xl transition-all duration-200 border ${
                  isSelected
                    ? "bg-blue-600/10 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.1)]"
                    : "bg-gray-800/30 border-transparent hover:bg-gray-800/80 hover:border-gray-700"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-sm font-semibold ${isSelected ? "text-blue-400" : "text-gray-200"}`}>
                    Batch #{batch.id}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 text-xs font-medium border border-gray-700">
                    {batch.package_count || 0} pkgs
                  </span>
                </div>
                <div className="flex items-center gap-2 mb-1">
                  {batch.client_name && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/20">
                      {batch.client_name}
                    </span>
                  )}
                  {batch.format && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">
                      {batch.format}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-500 truncate">{dateStr}</div>
                {batch.source && (
                  <div className="text-[10px] text-gray-600 mt-1 truncate" title={batch.source}>
                    {batch.source}
                  </div>
                )}
              </button>
            );
          })
        )}
      </div>
    </div>
    {isRunModalOpen && (
      <RunAgentModal
        onClose={() => setIsRunModalOpen(false)}
        onStarted={() => setIsTerminalOpen(true)}
        clients={clients}
        formats={formats}
        defaultClientId={selectedClientId}
      />
    )}
    {isTerminalOpen && (
      <TerminalLogs
        onClose={() => {
          setIsTerminalOpen(false);
          onRunStarted();
        }}
      />
    )}
    </>
  );
}
