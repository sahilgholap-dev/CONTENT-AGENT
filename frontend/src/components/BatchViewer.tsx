import React, { useEffect, useState } from "react";
import PackageViewer from "./PackageViewer";
import { apiFetch, apiUrlWithToken } from "@/lib/api";

export default function BatchViewer({
  batchId,
  portal = false,
}: {
  batchId: number;
  /** Client-portal mode: uses the client-scoped API and hides internal-only UI. */
  portal?: boolean;
}) {
  const [batch, setBatch] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPackageIdx, setSelectedPackageIdx] = useState(0);
  const apiBase = portal ? "/api/portal" : "/api";

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    apiFetch(`${apiBase}/batches/${batchId}`)
      .then((res) => res.json())
      .then((data) => {
        setBatch(data);
        setSelectedPackageIdx(0);
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load batch details", err);
        setLoading(false);
      });
  }, [batchId, apiBase]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cs-accent"></div>
      </div>
    );
  }

  if (!batch || !batch.packages) {
    return (
      <div className="flex-1 p-8 text-cs-muted">
        Could not load batch data or batch is empty.
      </div>
    );
  }

  const handleDownload = async () => {
    // Token goes in the query string: a plain navigation can't set headers.
    const url = await apiUrlWithToken(`${apiBase}/batches/${batch.id}/download`);
    window.location.href = url;
  };

  return (
    <div className="flex flex-col h-full bg-cs-page">
      <div className="shrink-0 p-6 border-b border-cs-border bg-white  sticky top-0 z-10">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <h2 className="text-2xl font-bold text-cs-text">
                Batch #{batch.id as number}
              </h2>
              {batch.client_id && (
                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-cs-accent-soft text-cs-accent-deep border border-cs-accent/20">
                  {batch.client_id as string}
                </span>
              )}
              {batch.format && (
                <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-white text-cs-muted border border-cs-border-strong">
                  {batch.format as string}
                </span>
              )}
            </div>
            <p className="text-sm text-cs-muted">
              {batch.batch_date as string} • {(batch.packages as any[])?.length || 0} packages ({(batch.ready_for_review_count as number) || 0} ready, {(batch.needs_review_count as number) || 0} needs review)
            </p>
            {batch.requested_topic && (
              <p className="text-xs text-cs-muted mt-1">
                <span className="text-cs-muted font-medium">Requested topic:</span>{" "}
                {batch.requested_topic as string}
              </p>
            )}
          </div>
          <button
            onClick={handleDownload}
            className="px-5 py-2.5 bg-cs-accent hover:bg-cs-accent-hover text-cs-text text-sm font-semibold rounded-lg shadow-lg shadow-cs transition-all border border-cs-accent active:scale-95"
          >
            Download ZIP
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm font-medium text-cs-muted">Package:</label>
          <select
            className="flex-1 max-w-xl bg-white border border-cs-border-strong text-cs-text text-sm rounded-lg focus:ring-cs-accent-soft focus:border-cs-accent block p-2.5 outline-none transition-colors"
            value={selectedPackageIdx}
            onChange={(e) => setSelectedPackageIdx(Number(e.target.value))}
          >
            {(batch.packages as any[]).map((pkg: Record<string, any>, idx: number) => (
              <option key={idx} value={idx}>
                [{pkg.review_status as string || "unknown"}] {pkg.topic as string || `Package ${idx + 1}`}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {(batch.packages as any[])[selectedPackageIdx] && (
          <PackageViewer pkg={(batch.packages as any[])[selectedPackageIdx]} portal={portal} />
        )}
      </div>
    </div>
  );
}
