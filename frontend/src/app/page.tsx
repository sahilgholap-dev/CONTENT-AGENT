import { redirect } from "next/navigation";

// The proxy routes "/" by portal role (admin -> /admin, client -> /portal)
// before this ever renders; this is only a fallback for direct hits.
export default function Root() {
  redirect("/login");
}
