"use client";

import { createBrowserClient } from "@supabase/ssr";

// Browser-side Supabase client. Reads the public env vars injected at build time.
// Used by client components to log in/out and to read the current access token
// that gets forwarded to the FastAPI backend as a Bearer credential.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
