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

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 p-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
          Content Engine
        </h1>
        <p className="mb-8 text-center text-xs uppercase tracking-wider text-gray-500">
          Sign in to continue
        </p>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-gray-800 bg-gray-900/50 p-6 shadow-xl backdrop-blur-md"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="block w-full rounded-lg border border-gray-700 bg-gray-800 p-2.5 text-sm text-gray-200 outline-none transition-colors focus:border-blue-500 focus:ring-blue-500"
              placeholder="you@casinogurus.org"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">Password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-lg border border-gray-700 bg-gray-800 p-2.5 text-sm text-gray-200 outline-none transition-colors focus:border-blue-500 focus:ring-blue-500"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-sm text-red-400">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg border border-blue-400/20 bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-500 active:scale-95 disabled:opacity-60"
          >
            {loading ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
