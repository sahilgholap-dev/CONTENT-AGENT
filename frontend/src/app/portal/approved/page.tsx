"use client";

import PageHeader from "@/components/portal/PageHeader";

export default function ApprovedPage() {
  return (
    <>
      <PageHeader title="Approved" subtitle="Pieces you've signed off on · ready to use" />
      <div className="max-w-[1200px] px-8 py-6 pb-20">
        <div className="rounded-[10px] border border-cs-border bg-white p-6 text-cs-muted shadow-cs">
          Approved pieces appear here — coming in the next build step.
        </div>
      </div>
    </>
  );
}
