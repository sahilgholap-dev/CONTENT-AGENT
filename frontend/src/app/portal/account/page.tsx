"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

/** Portal account page: change password (clients arrive with an admin-issued
 *  temporary password and set their own here). */
export default function AccountPage() {
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setEmail(data.user?.email ?? ""));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSaving(true);
    const { error } = await createClient().auth.updateUser({ password });
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    setPassword("");
    setConfirm("");
    setMessage("Password updated.");
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-950 p-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-center text-2xl font-bold bg-gradient-to-r from-blue-400 to-indigo-400 bg-clip-text text-transparent">
          Account
        </h1>
        <p className="mb-8 text-center text-xs text-gray-500">{email}</p>

        <form
          onSubmit={handleSubmit}
          className="space-y-4 rounded-2xl border border-gray-800 bg-gray-900/50 p-6 shadow-xl backdrop-blur-md"
        >
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">New password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full rounded-lg border border-gray-700 bg-gray-800 p-2.5 text-sm text-gray-200 outline-none transition-colors focus:border-blue-500 focus:ring-blue-500"
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-400">Confirm new password</label>
            <input
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="block w-full rounded-lg border border-gray-700 bg-gray-800 p-2.5 text-sm text-gray-200 outline-none transition-colors focus:border-blue-500 focus:ring-blue-500"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-sm text-red-400">
              {error}
            </div>
          )}
          {message && (
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-2.5 text-sm text-green-400">
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-lg border border-blue-400/20 bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-500/20 transition-all hover:bg-blue-500 active:scale-95 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Update password"}
          </button>
        </form>

        <p className="mt-6 text-center">
          <Link href="/portal" className="text-xs text-gray-400 hover:text-gray-200 transition-colors">
            ← Back to your content
          </Link>
        </p>
      </div>
    </div>
  );
}
