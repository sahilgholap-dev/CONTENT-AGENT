"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ClientProfileForm from "@/components/ClientProfileForm";
import { apiFetch } from "@/lib/api";

export default function ClientsPage() {
  const [clients, setClients] = useState<any[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<Record<string, any> | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadClients = useCallback(() => {
    apiFetch("/api/clients")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setClients(data);
          setSelectedId((prev) => prev ?? (data.length > 0 ? data[0].id : null));
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load clients", err);
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    loadClients();
  }, [loadClients]);

  const loadDetail = useCallback((clientId: string) => {
    apiFetch(`/api/clients/${encodeURIComponent(clientId)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data && data.id) setSelectedClient(data);
      })
      .catch((err) => console.error("Failed to load client", err));
  }, []);

  // Load the full client (incl. profile) when the selection changes.
  useEffect(() => {
    if (!selectedId || creating) return;
    loadDetail(selectedId);
  }, [selectedId, creating, loadDetail]);

  const handleSaved = useCallback(() => {
    loadClients();
    if (selectedId) loadDetail(selectedId);
  }, [loadClients, loadDetail, selectedId]);

  // Derived: only show the loaded client when it matches the selection.
  const displayedClient = !creating && selectedClient?.id === selectedId ? selectedClient : null;
  const detailLoading = !creating && !!selectedId && !displayedClient;

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      {/* Left: client list */}
      <div className="w-80 bg-gray-900/50 backdrop-blur-md border-r border-gray-800 flex flex-col h-full shrink-0">
        <div className="p-6 border-b border-gray-800">
          <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
            Clients
          </h1>
          <div className="flex justify-between items-center mt-2">
            <Link href="/" className="text-xs text-gray-400 hover:text-gray-200 transition-colors">
              ← Back to batches
            </Link>
            <button
              onClick={() => {
                setCreating(true);
                setSelectedId(null);
              }}
              className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 bg-blue-600/20 text-blue-400 border border-blue-500/30 rounded hover:bg-blue-600 hover:text-white transition-colors"
            >
              + New Client
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="text-gray-500 text-sm p-2 animate-pulse">Loading...</div>
          ) : clients.length === 0 ? (
            <div className="text-gray-500 text-sm p-2">No clients yet</div>
          ) : (
            clients.map((c) => {
              const isSelected = !creating && c.id === selectedId;
              return (
                <button
                  key={c.id}
                  onClick={() => {
                    setCreating(false);
                    setSelectedId(c.id);
                  }}
                  className={`w-full text-left p-4 rounded-xl transition-all duration-200 border ${
                    isSelected
                      ? "bg-blue-600/10 border-blue-500/50"
                      : "bg-gray-800/30 border-transparent hover:bg-gray-800/80 hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-semibold ${isSelected ? "text-blue-400" : "text-gray-200"}`}>
                      {c.display_name}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        c.status === "active"
                          ? "bg-green-500/15 text-green-400"
                          : "bg-gray-800 text-gray-500 border border-gray-700"
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">{c.site_domain}</div>
                  <div className="text-[10px] text-gray-600 mt-1">profile v{c.profile_version}</div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right: profile editor */}
      <main className="flex-1 min-w-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-8">
          <h2 className="text-2xl font-bold text-white mb-1">
            {creating ? "Onboard New Client" : displayedClient?.display_name ?? "Select a client"}
          </h2>
          <p className="text-sm text-gray-500 mb-8">
            {creating
              ? "The profile below is authored by the internal team and is strictly specific to this client."
              : displayedClient
              ? `Profile v${displayedClient.profile_version} — saving creates v${(displayedClient.profile_version ?? 0) + 1}; in-flight runs keep their pinned version.`
              : ""}
          </p>
          {detailLoading ? (
            <div className="flex items-center justify-center py-24">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
            </div>
          ) : creating ? (
            <ClientProfileForm key="__new__" client={null} onSaved={loadClients} />
          ) : displayedClient ? (
            <ClientProfileForm
              key={`${displayedClient.id}-v${displayedClient.profile_version}`}
              client={displayedClient}
              onSaved={handleSaved}
            />
          ) : (
            <div className="text-gray-500">Select a client on the left, or create a new one.</div>
          )}
        </div>
      </main>
    </div>
  );
}
