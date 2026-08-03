"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { usePortal } from "@/components/portal/PortalShell";

const NAV = [
  { href: "/portal/create", icon: "＋", label: "Create" },
  { href: "/portal/drafts", icon: "✎", label: "Drafts" },
  { href: "/portal/approved", icon: "✓", label: "Approved" },
];

/** New light-product sidebar (portal only — the admin keeps the old
 *  src/components/Sidebar.tsx untouched). Brand block, workspace switcher
 *  for multi-business logins, three nav items, user box with sign-out. */
export default function PortalSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { me, activeClientId, activeClient, switchClient } = usePortal();

  const handleSignOut = async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  };

  const initials = (me?.email ?? "?").slice(0, 2).toUpperCase();

  return (
    <aside className="flex w-60 shrink-0 flex-col bg-cs-nav py-5 text-slate-200 min-h-screen sticky top-0 max-h-screen">
      <div className="border-b border-white/10 px-5 pb-5">
        <div className="text-[11px] font-bold tracking-[2px] text-cs-accent">NEXUS</div>
        <div className="text-[15px] font-semibold tracking-[-0.2px] text-slate-100">
          Content Studio
        </div>
      </div>

      {me && me.clients.length > 1 ? (
        <div className="mx-3 mt-3">
          <select
            value={activeClientId ?? ""}
            onChange={(e) => switchClient(e.target.value)}
            className="w-full rounded-md border border-white/15 bg-cs-nav-hover p-2 text-[12.5px] font-medium text-slate-100 outline-none"
          >
            {me.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name}
              </option>
            ))}
          </select>
        </div>
      ) : activeClient ? (
        <div className="mx-3 mt-3 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-[12px] text-slate-300">
          {activeClient.display_name}
        </div>
      ) : null}

      <nav className="mt-3 flex-1 px-3">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`my-0.5 flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13.5px] font-medium transition-colors ${
                active
                  ? "bg-cs-nav-hover text-white"
                  : "text-slate-300 hover:bg-cs-nav-hover hover:text-slate-100"
              }`}
            >
              <span className="inline-flex w-[18px] items-center justify-center text-sm">
                {item.icon}
              </span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex items-center gap-2.5 border-t border-white/10 px-4 pt-3.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-indigo-400 to-cs-accent text-[13px] font-semibold text-white">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-slate-100">
            {me?.email ?? "…"}
          </div>
          <div className="truncate text-[11px] text-slate-400">
            {activeClient?.site_domain ?? ""}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Link
            href="/portal/account"
            className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-cs-nav-hover hover:text-slate-100"
            title="Account"
          >
            ⚙
          </Link>
          <button
            onClick={handleSignOut}
            className="rounded px-1.5 py-0.5 text-[11px] text-slate-400 hover:bg-cs-nav-hover hover:text-slate-100"
            title="Sign out"
          >
            ↩
          </button>
        </div>
      </div>
    </aside>
  );
}
