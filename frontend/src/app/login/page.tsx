"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    // Full navigation so the proxy re-reads the refreshed session cookie.
    router.push("/");
    router.refresh();
  };

  const inputClass =
    "block w-full rounded-md border border-cs-border-strong bg-white p-2.5 text-[13.5px] text-cs-text outline-none transition-colors focus:border-cs-accent focus:ring-[3px] focus:ring-cs-accent-soft";

  return (
    <div
      className="flex min-h-screen items-center justify-center p-10 text-sm"
      style={{
        background: "linear-gradient(135deg, #1A1B2E 0%, #312E81 100%)",
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif',
      }}
    >
      <div className="w-full max-w-[400px] rounded-[14px] bg-white p-10 text-cs-text shadow-[0_20px_60px_rgba(0,0,0,0.3)]">
        <div className="mb-7 text-center">
          <div className="text-[11px] font-bold tracking-[2px] text-cs-accent">NEXUS</div>
          <div className="mt-1 text-[22px] font-bold tracking-[-0.4px]">Content Studio</div>
          <div className="mt-1.5 text-[13px] text-cs-muted">Sign in to your workspace</div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[13px] font-medium">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[13px] font-medium">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="rounded-md border border-cs-danger/30 bg-cs-danger-soft p-2.5 text-[13px] text-cs-danger">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md border border-cs-accent bg-cs-accent px-4 py-2.5 text-[13.5px] font-medium text-white transition-colors hover:bg-cs-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="mt-7 border-t border-cs-border pt-4 text-center text-[11.5px] text-cs-light">
          New workspace? Get in touch with your MasterTech onboarder.
        </div>
      </div>
    </div>
  );
}
