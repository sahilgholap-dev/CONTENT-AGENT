"use client";

import { useParams } from "next/navigation";
import DraftsView from "@/components/portal/DraftsView";

/** Deep link to one draft: same two-pane view, pre-selected. */
export default function DraftDeepLink() {
  const params = useParams<{ id: string }>();
  return <DraftsView initialId={String(params.id)} />;
}
