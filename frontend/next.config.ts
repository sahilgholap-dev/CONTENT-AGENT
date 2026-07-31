import type { NextConfig } from "next";

// The dashboard talks to the FastAPI backend directly via NEXT_PUBLIC_API_URL
// (see src/lib/api.ts), so the old localhost proxy rewrite is gone. CORS is
// handled on the backend.
const nextConfig: NextConfig = {
  // The repo root has its own package-lock.json, so Turbopack's workspace-root
  // inference picks the wrong directory and eventually panics ("Next.js
  // package not found"). Pin the root to this app explicitly.
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
