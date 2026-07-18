"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BatchViewer from "@/components/BatchViewer";
import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

/** Client portal home: their batches only (scoped server-side by the JWT's
 *  client_id), with the standard batch viewer in portal mode. */
export default function PortalDashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Record<string, any> | null>(null);
  const [batches, setBatches] = useState<any[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    apiFetch("/api/portal/me")
      .then((res) => res.json())
      .then((data) => data?.id && setMe(data))
      .catch(() => {});
    apiFetch("/api/portal/batches")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setBatches(data);
          setSelectedBatchId((prev) => prev ?? (data.length > 0 ? data[0].id : null));
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      {/* Left: batch list */}
      <div className="w-80 bg-gray-900/50 backdrop-blur-md border-r border-gray-800 flex flex-col h-full shrink-0">
        <div className="p-6 border-b border-gray-800">
          <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
            {me?.display_name ?? "Content Portal"}
          </h1>
          <p className="text-xs text-gray-500 mt-1">{me?.site_domain ?? ""}</p>
          <div className="flex justify-between items-center mt-3">
            <p className="text-xs text-gray-400 uppercase tracking-wider">Your Content</p>
            <div className="flex items-center gap-2">
              <Link
                href="/portal/account"
                className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 bg-gray-800 text-gray-400 border border-gray-700 rounded hover:text-gray-200 hover:border-gray-500 transition-colors"
              >
                Account
              </Link>
              <button
                onClick={handleSignOut}
                className="text-[10px] uppercase font-bold tracking-wider px-2 py-1 bg-gray-800 text-gray-400 border border-gray-700 rounded hover:text-red-300 hover:border-red-500/40 transition-colors"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="text-gray-500 text-sm p-2 animate-pulse">Loading…</div>
          ) : batches.length === 0 ? (
            <div className="text-gray-500 text-sm p-2">
              No content yet — new batches appear here as soon as they're produced.
            </div>
          ) : (
            batches.map((b) => {
              const isSelected = b.id === selectedBatchId;
              return (
                <button
                  key={b.id}
                  onClick={() => setSelectedBatchId(b.id)}
                  className={`w-full text-left p-4 rounded-xl transition-all duration-200 border ${
                    isSelected
                      ? "bg-blue-600/10 border-blue-500/50"
                      : "bg-gray-800/30 border-transparent hover:bg-gray-800/80 hover:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-sm font-semibold ${isSelected ? "text-blue-400" : "text-gray-200"}`}>
                      {b.batch_date}
                    </span>
                    {b.format && (
                      <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-gray-800 text-gray-400 border border-gray-700">
                        {b.format}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {b.package_count ?? b.total_packages ?? 0} article
                    {(b.package_count ?? b.total_packages ?? 0) === 1 ? "" : "s"}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* Right: batch viewer (portal mode — no Raw JSON, scoped API) */}
      <main className="flex-1 min-w-0 overflow-hidden">
        {selectedBatchId != null ? (
          <BatchViewer batchId={selectedBatchId} portal />
        ) : (
          <div className="flex h-full items-center justify-center text-gray-500">
            {loading ? "" : "Select a batch on the left."}
          </div>
        )}
      </main>
    </div>
  );
}
