"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { apiFetch, setPortalClientId } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import PortalSidebar from "@/components/portal/Sidebar";

type PortalContextValue = {
  me: { email: string; clients: any[] } | null;
  activeClientId: string | null;
  activeClient: any | null;
  switchClient: (cid: string) => void;
};

const PortalContext = createContext<PortalContextValue>({
  me: null,
  activeClientId: null,
  activeClient: null,
  switchClient: () => {},
});

export function usePortal() {
  return useContext(PortalContext);
}

/** Client-portal shell: dark-navy sidebar + light main area. Owns the
 *  session boot (refresh once so admin assignment edits apply on reload)
 *  and the multi-business scope; pages consume it via usePortal(). */
export default function PortalShell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<{ email: string; clients: any[] } | null>(null);
  const [activeClientId, setActiveClientId] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth
      .refreshSession()
      .catch(() => {})
      .then(() =>
        apiFetch("/api/portal/me")
          .then((res) => res.json())
          .then((data) => {
            if (!Array.isArray(data?.clients) || data.clients.length === 0) return;
            setMe(data);
            const stored = localStorage.getItem(`portal-active-client:${data.email ?? ""}`);
            const cid = data.clients.some((c: any) => c.id === stored)
              ? (stored as string)
              : data.clients[0].id;
            setPortalClientId(cid);
            setActiveClientId(cid);
          })
          .catch(() => {})
      );
  }, []);

  const switchClient = (cid: string) => {
    if (cid === activeClientId) return;
    setPortalClientId(cid);
    if (me?.email) localStorage.setItem(`portal-active-client:${me.email}`, cid);
    setActiveClientId(cid);
  };

  const activeClient = me?.clients.find((c) => c.id === activeClientId) ?? null;

  return (
    <PortalContext.Provider value={{ me, activeClientId, activeClient, switchClient }}>
      <div
        className="flex min-h-screen bg-cs-page text-cs-text text-sm"
        style={{
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif',
        }}
      >
        <PortalSidebar />
        <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
      </div>
    </PortalContext.Provider>
  );
}
