import type { NextConfig } from "next";

// The dashboard talks to the FastAPI backend directly via NEXT_PUBLIC_API_URL
// (see src/lib/api.ts), so the old localhost proxy rewrite is gone. CORS is
// handled on the backend.
const nextConfig: NextConfig = {};

export default nextConfig;
