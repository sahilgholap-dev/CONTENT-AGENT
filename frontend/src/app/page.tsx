"use client";

import { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import BatchViewer from "@/components/BatchViewer";

export default function Dashboard() {
  const [batches, setBatches] = useState<any[]>([]);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/batches")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setBatches(data);
          if (data.length > 0) {
            setSelectedBatchId(data[0].id);
          }
        }
        setLoading(false);
      })
      .catch((err) => {
        console.error("Failed to load batches", err);
        setLoading(false);
      });
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-gray-950">
      <Sidebar
        batches={batches}
        selectedBatchId={selectedBatchId}
        onSelectBatch={setSelectedBatchId}
        loading={loading}
      />
      <main className="flex-1 flex flex-col min-w-0 overflow-y-auto">
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
