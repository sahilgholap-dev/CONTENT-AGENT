"use client";

import { createClient } from "@/lib/supabase/client";

// Base URL of the FastAPI backend (Render). Empty string => same-origin (only
// used if you proxy locally); normally set to the Render URL via env.
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

// Active portal business for multi-client logins. Once set, every
// /api/portal request carries it as ?client_id=; the backend validates it
// against the JWT's allowed client list (forged values get a 403).
let portalClientId: string | null = null;

export function setPortalClientId(id: string | null) {
  portalClientId = id;
}

function withPortalClient(path: string): string {
  if (!portalClientId || !path.startsWith("/api/portal")) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}client_id=${encodeURIComponent(portalClientId)}`;
}

async function getToken(): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

/** fetch() against the backend with the Supabase JWT attached as a Bearer token. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${BASE}${withPortalClient(path)}`, { ...init, headers });
}

/**
 * Build a full backend URL with the token in the query string, for the two
 * cases that cannot send an Authorization header: the SSE log stream
 * (EventSource) and the ZIP download link. The backend accepts `?access_token=`.
 */
export async function apiUrlWithToken(path: string): Promise<string> {
  const token = await getToken();
  const url = new URL(`${BASE}${withPortalClient(path)}`, window.location.origin);
  if (token) url.searchParams.set("access_token", token);
  return url.toString();
}
