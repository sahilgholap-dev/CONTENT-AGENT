"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import PageHeader from "@/components/portal/PageHeader";

/** Portal account page: change password (clients arrive with an admin-issued
 *  temporary password and set their own here). Renders inside the Content
 *  Studio shell. */
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

  const inputClass =
    "block w-full rounded-md border border-cs-border-strong bg-white p-2.5 text-[13.5px] outline-none transition-colors focus:border-cs-accent focus:ring-[3px] focus:ring-cs-accent-soft";

  return (
    <>
      <PageHeader title="Account" subtitle={email} />
      <div className="max-w-[1200px] px-8 py-6 pb-20">
        <form
          onSubmit={handleSubmit}
          className="max-w-sm space-y-4 rounded-[10px] border border-cs-border bg-white p-6 shadow-cs"
        >
          <div>
            <label className="mb-1.5 block text-[13px] font-medium">New password</label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[13px] font-medium">Confirm new password</label>
            <input
              type="password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputClass}
              placeholder="••••••••"
            />
          </div>

          {error && (
            <div className="rounded-md border border-red-200 bg-cs-danger-soft p-2.5 text-[13px] text-cs-danger">
              {error}
            </div>
          )}
          {message && (
            <div className="rounded-md border border-emerald-200 bg-cs-emerald-soft p-2.5 text-[13px] text-emerald-700">
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={saving}
            className="w-full rounded-md border border-cs-accent bg-cs-accent px-4 py-2.5 text-[13.5px] font-medium text-white transition-colors hover:bg-cs-accent-hover disabled:opacity-50"
          >
            {saving ? "Saving…" : "Update password"}
          </button>
        </form>
      </div>
    </>
  );
}
