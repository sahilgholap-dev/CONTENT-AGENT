import { redirect } from "next/navigation";

// Drafts is the landing screen for a returning user.
export default function PortalIndex() {
  redirect("/portal/drafts");
}
