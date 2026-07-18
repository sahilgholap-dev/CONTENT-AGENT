"use client";

import { useCallback, useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import BatchViewer from "@/components/BatchViewer";
import { apiFetch } from "@/lib/api";

const CLIENT_STORAGE_KEY = "nexus.selectedClientId";

export default function Dashboard() {
  const [batches, setBatches] = useState<any[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState<any[]>([]);
  const [formats, setFormats] = useState<any[]>([]);
  // null => "All clients"
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  // Restore the last-used client filter (external system: localStorage).
  useEffect(() => {
    const stored = localStorage.getItem(CLIENT_STORAGE_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setSelectedClientId(stored === "__all__" ? null : stored);
  }, []);

  const handleSelectClient = useCallback((clientId: string | null) => {
    setSelectedClientId(clientId);
    localStorage.setItem(CLIENT_STORAGE_KEY, clientId ?? "__all__");
  }, []);

  // Clients + formats are static per session; fetch once.
  useEffect(() => {
    apiFetch("/api/clients")
      .then((res) => res.json())
      .then((data) => Array.isArray(data) && setClients(data))
      .catch((err) => console.error("Failed to load clients", err));
    apiFetch("/api/formats")
      .then((res) => res.json())
      .then((data) => Array.isArray(data?.content_types) && setFormats(data.content_types))
      .catch((err) => console.error("Failed to load formats", err));
  }, []);

  const loadBatches = useCallback(() => {
    // `loading` starts true; refetches keep showing the previous list until
    // the new one arrives (no sync setState inside the effect-invoked path).
    const qs = selectedClientId ? `?client_id=${encodeURIComponent(selectedClientId)}` : "";
    apiFetch(`/api/batches${qs}`)
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setBatches(data);
          setSelectedBatchId(data.length > 0 ? data[0].id : null);
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load batches", err);
        setLoading(false);
      });
  }, [selectedClientId]);

  useEffect(() => {
    loadBatches();
  }, [loadBatches]);

  return (
    <div className="flex flex-col md:flex-row h-screen overflow-hidden bg-gray-950">
      <Sidebar
        batches={batches}
        selectedBatchId={selectedBatchId}
        onSelectBatch={setSelectedBatchId}
        loading={loading}
        clients={clients}
        formats={formats}
        selectedClientId={selectedClientId}
        onSelectClient={handleSelectClient}
        onRunStarted={loadBatches}
      />
      <main className="flex-1 flex flex-col min-w-0 min-h-0 overflow-y-auto">
        {selectedBatchId ? (
          <BatchViewer batchId={selectedBatchId} />
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-500">
            {loading ? "Loading batches..." : "No batches found."}
          </div>
        )}
      </main>
    </div>
  );
}
