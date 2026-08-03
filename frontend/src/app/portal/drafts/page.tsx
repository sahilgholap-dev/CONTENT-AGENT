"use client";

import PageHeader from "@/components/portal/PageHeader";

export default function DraftsPage() {
  return (
    <>
      <PageHeader title="Drafts" subtitle="Pieces waiting for your review" />
      <div className="max-w-[1200px] px-8 py-6 pb-20">
        <div className="rounded-[10px] border border-cs-border bg-white p-6 text-cs-muted shadow-cs">
          Drafts land here — coming in the next build step.
        </div>
      </div>
    </>
  );
}
