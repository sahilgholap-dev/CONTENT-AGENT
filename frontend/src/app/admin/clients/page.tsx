"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import ClientProfileForm from "@/components/ClientProfileForm";
import LearningPanel from "@/components/LearningPanel";
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
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-cs-page">
      {/* Left: client list */}
      <div className="w-full md:w-80 bg-white  border-b md:border-b-0 md:border-r border-cs-border flex flex-col max-h-[40vh] md:max-h-none md:h-full shrink-0">
        <div className="p-6 border-b border-cs-border">
          <h1 className="text-xl font-bold text-cs-accent-deep">
            Clients
          </h1>
          <div className="flex justify-between items-center mt-2">
            <Link href="/admin" className="text-xs text-cs-muted hover:text-cs-text transition-colors">
              ← Back to batches
            </Link>
            <button
              onClick={() => {
                setCreating(true);
                setSelectedId(null);
              }}
              className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 bg-cs-accent-soft text-cs-accent border border-cs-accent/40 rounded hover:bg-cs-accent-hover hover:text-white transition-colors"
            >
              + New Client
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="text-cs-muted text-sm p-2 animate-pulse">Loading...</div>
          ) : clients.length === 0 ? (
            <div className="text-cs-muted text-sm p-2">No clients yet</div>
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
                      ? "bg-cs-accent-soft border-cs-accent"
                      : "bg-cs-gray-soft border-transparent hover:bg-cs-gray-soft hover:border-cs-light"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-semibold ${isSelected ? "text-cs-accent" : "text-cs-text"}`}>
                      {c.display_name}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        c.status === "active"
                          ? "bg-green-500/15 text-emerald-600"
                          : "bg-white text-cs-muted border border-cs-border-strong"
                      }`}
                    >
                      {c.status}
                    </span>
                  </div>
                  <div className="text-xs text-cs-muted mt-1">{c.site_domain}</div>
                  <div className="text-[10px] text-cs-light mt-1">profile v{c.profile_version}</div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right: profile editor */}
      <main className="flex-1 min-w-0 min-h-0 overflow-y-auto">
        <div className="max-w-4xl mx-auto p-8">
          <h2 className="text-2xl font-bold text-cs-text mb-1">
            {creating ? "Onboard New Client" : displayedClient?.display_name ?? "Select a client"}
          </h2>
          <p className="text-sm text-cs-muted mb-8">
            {creating
              ? "The profile below is authored by the internal team and is strictly specific to this client."
              : displayedClient
              ? `Profile v${displayedClient.profile_version} — saving creates v${(displayedClient.profile_version ?? 0) + 1}; in-flight runs keep their pinned version.`
              : ""}
          </p>
          {detailLoading ? (
            <div className="flex items-center justify-center py-24">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cs-accent"></div>
            </div>
          ) : creating ? (
            <ClientProfileForm key="__new__" client={null} onSaved={loadClients} />
          ) : displayedClient ? (
            <>
              <LearningPanel clientId={displayedClient.id} onAccepted={handleSaved} />
              <ClientProfileForm
                key={`${displayedClient.id}-v${displayedClient.profile_version}`}
                client={displayedClient}
                onSaved={handleSaved}
              />
            </>
          ) : (
            <div className="text-cs-muted">Select a client on the left, or create a new one.</div>
          )}
        </div>
      </main>
    </div>
  );
}
