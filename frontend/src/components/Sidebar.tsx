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
      <div className="w-full md:w-80 bg-white  border-b md:border-b-0 md:border-r border-cs-border flex flex-col max-h-[45vh] md:max-h-none md:h-full shrink-0">
      <div className="p-6 border-b border-cs-border">
        <div className="text-[11px] font-bold tracking-[2px] text-cs-accent">NEXUS</div>
        <h1 className="text-lg font-semibold tracking-[-0.2px] text-cs-text">
          Content Studio <span className="text-cs-muted font-normal">· Admin</span>
        </h1>

        <div className="mt-3">
          <select
            className="w-full bg-white border border-cs-border-strong text-cs-text text-xs rounded-lg focus:ring-cs-accent-soft focus:border-cs-accent p-2 outline-none transition-colors"
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
        </div>

        <div className="mt-2 grid grid-cols-3 gap-2">
          <Link
            href="/admin/clients"
            className="text-[10px] uppercase font-bold tracking-wider px-2 py-2 bg-white text-cs-muted border border-cs-border-strong rounded text-center hover:text-cs-text hover:border-cs-light transition-colors"
            title="Manage clients"
          >
            Clients
          </Link>
          <Link
            href="/admin/registry"
            className="text-[10px] uppercase font-bold tracking-wider px-2 py-2 bg-white text-cs-muted border border-cs-border-strong rounded text-center hover:text-cs-text hover:border-cs-light transition-colors"
            title="Manage content types & formats"
          >
            Formats
          </Link>
          <Link
            href="/admin/users"
            className="text-[10px] uppercase font-bold tracking-wider px-2 py-2 bg-white text-cs-muted border border-cs-border-strong rounded text-center hover:text-cs-text hover:border-cs-light transition-colors"
            title="Manage portal logins"
          >
            Users
          </Link>
        </div>

        <div className="flex justify-between items-center mt-3">
          <p className="text-xs text-cs-muted uppercase tracking-wider">
            Batch Viewer
          </p>
          <button
            onClick={() => setIsRunModalOpen(true)}
            className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 bg-cs-accent-soft text-cs-accent border border-cs-accent/40 rounded hover:bg-cs-accent-hover hover:text-white transition-colors"
          >
            ▶ Run Agent
          </button>
        </div>
        <button
          onClick={handleSignOut}
          className="mt-3 text-[10px] uppercase font-bold tracking-wider text-cs-muted hover:text-cs-text transition-colors"
        >
          Sign out
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <div className="text-cs-muted text-sm p-2 animate-pulse">Loading...</div>
        ) : batches.length === 0 ? (
          <div className="text-cs-muted text-sm p-2">No batches found</div>
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
                    ? "bg-cs-accent-soft border-cs-accent shadow-[0_0_15px_rgba(59,130,246,0.1)]"
                    : "bg-cs-gray-soft border-transparent hover:bg-cs-gray-soft hover:border-cs-light"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className={`text-sm font-semibold ${isSelected ? "text-cs-accent" : "text-cs-text"}`}>
                    Batch #{batch.id}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-white text-cs-muted text-xs font-medium border border-cs-border-strong">
                    {batch.package_count || 0} pkgs
                  </span>
                </div>
                <div className="flex items-center gap-2 mb-1">
                  {batch.client_name && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-cs-accent-soft text-cs-accent-deep border border-cs-accent/20">
                      {batch.client_name}
                    </span>
                  )}
                  {batch.format && (
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white text-cs-muted border border-cs-border-strong">
                      {batch.format}
                    </span>
                  )}
                </div>
                <div className="text-xs text-cs-muted truncate">{dateStr}</div>
                {batch.source && (
                  <div className="text-[10px] text-cs-light mt-1 truncate" title={batch.source}>
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
