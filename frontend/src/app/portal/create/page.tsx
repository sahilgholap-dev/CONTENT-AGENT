"use client";

import PageHeader from "@/components/portal/PageHeader";

export default function CreatePage() {
  return (
    <>
      <PageHeader title="Create" subtitle="Pick what you want to make" />
      <div className="max-w-[1200px] px-8 py-6 pb-20">
        <div className="rounded-[10px] border border-cs-border bg-white p-6 text-cs-muted shadow-cs">
          The Create wizard lands here — coming in the next build step.
        </div>
      </div>
    </>
  );
}
