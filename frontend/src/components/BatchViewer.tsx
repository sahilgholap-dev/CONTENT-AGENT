import React, { useEffect, useState } from "react";
import PackageViewer from "./PackageViewer";
import { apiFetch, apiUrlWithToken } from "@/lib/api";

export default function BatchViewer({ batchId }: { batchId: number }) {
  const [batch, setBatch] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPackageIdx, setSelectedPackageIdx] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    apiFetch(`/api/batches/${batchId}`)
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
  }, [batchId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  if (!batch || !batch.packages) {
    return (
      <div className="flex-1 p-8 text-gray-500">
        Could not load batch data or batch is empty.
      </div>
    );
  }

  const handleDownload = async () => {
    // Token goes in the query string: a plain navigation can't set headers.
    const url = await apiUrlWithToken(`/api/batches/${batch.id}/download`);
    window.location.href = url;
  };

  return (
    <div className="flex flex-col h-full bg-gray-950">
      <div className="shrink-0 p-6 border-b border-gray-800 bg-gray-900/40 backdrop-blur-md sticky top-0 z-10">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-2xl font-bold text-white mb-1">
              Batch #{batch.id as number}
            </h2>
            <p className="text-sm text-gray-400">
              {batch.batch_date as string} • {(batch.packages as any[])?.length || 0} packages ({(batch.ready_for_review_count as number) || 0} ready, {(batch.needs_review_count as number) || 0} needs review)
            </p>
          </div>
          <button
            onClick={handleDownload}
            className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold rounded-lg shadow-lg shadow-blue-500/20 transition-all border border-blue-400/20 active:scale-95"
          >
            Download ZIP
          </button>
        </div>

        <div className="flex items-center space-x-3">
          <label className="text-sm font-medium text-gray-400">Package:</label>
          <select
            className="flex-1 max-w-xl bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 block p-2.5 outline-none transition-colors"
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
          <PackageViewer pkg={(batch.packages as any[])[selectedPackageIdx]} />
        )}
      </div>
    </div>
  );
}
