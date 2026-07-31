"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";

/** Admin: portal login management. Creating a client login generates a
 *  temporary password shown ONCE — copy it and share it with the client. */
export default function UsersPage() {
  const [users, setUsers] = useState<any[]>([]);
  const [clients, setClients] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"client" | "admin">("client");
  const [clientIds, setClientIds] = useState<string[]>([]);
  const [editing, setEditing] = useState<{
    id: string;
    email: string;
    role: "client" | "admin";
    client_ids: string[];
  } | null>(null);
  const [myUserId, setMyUserId] = useState<string | null>(null);

  // Last generated credential (shown once)
  const [credential, setCredential] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(() => {
    apiFetch("/api/admin/users")
      .then((res) => res.json())
      .then((data) => {
        if (Array.isArray(data)) setUsers(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
    apiFetch("/api/clients")
      .then((res) => res.json())
      .then((data) => Array.isArray(data) && setClients(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    createClient()
      .auth.getUser()
      .then(({ data }) => setMyUserId(data.user?.id ?? null));
  }, []);

  const toggleClientId = (id: string, list: string[], set: (v: string[]) => void) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const call = async (path: string, body?: Record<string, any>) => {
    setError(null);
    const res = await apiFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(String(data.detail || `Request failed (${res.status})`));
    return data;
  };

  const createUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy("create");
    setCredential(null);
    try {
      const data = await call("/api/admin/users", {
        email,
        role,
        client_ids: role === "client" ? clientIds : [],
      });
      setCredential({ email: data.user.email, password: data.temp_password });
      setCopied(false);
      setEmail("");
      setClientIds([]);
      setShowCreate(false);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const saveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    setBusy("edit");
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/users/${editing.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: editing.role,
          client_ids: editing.role === "client" ? editing.client_ids : [],
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(String(data.detail || `Request failed (${res.status})`));
      setEditing(null);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const resetPassword = async (u: any) => {
    if (!confirm(`Generate a new temporary password for ${u.email}? Their current password stops working.`)) return;
    setBusy(u.id);
    try {
      const data = await call(`/api/admin/users/${u.id}/reset-password`);
      setCredential({ email: u.email, password: data.temp_password });
      setCopied(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const toggleDisabled = async (u: any) => {
    if (u.disabled ? false : !confirm(`Disable login for ${u.email}?`)) return;
    setBusy(u.id);
    try {
      await call(`/api/admin/users/${u.id}/${u.disabled ? "enable" : "disable"}`);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const copyCredential = () => {
    if (!credential) return;
    navigator.clipboard.writeText(`Login: ${credential.email}\nTemporary password: ${credential.password}`);
    setCopied(true);
  };

  return (
    <div className="min-h-screen bg-gray-950">
      <div className="max-w-5xl mx-auto p-8">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold text-white">Portal Users</h1>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="text-xs uppercase font-bold tracking-wider px-3 py-2 bg-blue-600/20 text-blue-400 border border-blue-500/30 rounded-lg hover:bg-blue-600 hover:text-white transition-colors"
          >
            + Create Login
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-6">
          <Link href="/admin" className="hover:text-gray-300 transition-colors">← Back to batches</Link>
          <span className="mx-2">·</span>
          Client logins see only their own content at /portal. Admin logins see everything here.
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}</div>
        )}

        {credential && (
          <div className="mb-6 rounded-xl border border-green-500/40 bg-green-500/10 p-4">
            <div className="text-sm font-semibold text-green-300 mb-1">
              Credentials for {credential.email} — shown once, copy them now
            </div>
            <div className="font-mono text-sm text-gray-200 bg-gray-900 rounded-lg p-3 flex items-center justify-between gap-4">
              <span>{credential.password}</span>
              <button
                onClick={copyCredential}
                className="text-xs uppercase font-bold tracking-wider px-2 py-1 bg-gray-800 text-gray-300 border border-gray-700 rounded hover:border-gray-500 transition-colors shrink-0"
              >
                {copied ? "Copied ✓" : "Copy login + password"}
              </button>
            </div>
            <div className="text-[11px] text-gray-500 mt-2">
              Share these with the client securely. The password is not stored anywhere and cannot be viewed again — only reset.
            </div>
          </div>
        )}

        {showCreate && (
          <form onSubmit={createUser} className="mb-6 rounded-xl border border-gray-800 bg-gray-900/60 p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-400">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="client@example.com"
                  className="block w-full rounded-lg border border-gray-700 bg-gray-800 p-2.5 text-sm text-gray-200 outline-none focus:border-blue-500 transition-colors"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-400">Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as "client" | "admin")}
                  className="block w-full rounded-lg border border-gray-700 bg-gray-800 p-2.5 text-sm text-gray-200 outline-none focus:border-blue-500 transition-colors"
                >
                  <option value="client">Client (portal)</option>
                  <option value="admin">Admin (internal team)</option>
                </select>
              </div>
              {role === "client" && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-400">Clients (one or more)</label>
                  <div className="rounded-lg border border-gray-700 bg-gray-800 p-2.5 space-y-1.5 max-h-40 overflow-y-auto">
                    {clients.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={clientIds.includes(c.id)}
                          onChange={() => toggleClientId(c.id, clientIds, setClientIds)}
                          className="accent-blue-500"
                        />
                        {c.display_name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={busy === "create" || (role === "client" && clientIds.length === 0)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 transition-all disabled:opacity-60"
            >
              {busy === "create" ? "Creating…" : "Create login & generate password"}
            </button>
          </form>
        )}

        {editing && (
          <form onSubmit={saveEdit} className="mb-6 rounded-xl border border-blue-500/30 bg-gray-900/60 p-5 space-y-4">
            <div className="text-sm font-semibold text-gray-200">
              Edit {editing.email}
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="float-right text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-400">Role</label>
                <select
                  value={editing.role}
                  onChange={(e) => setEditing({ ...editing, role: e.target.value as "client" | "admin" })}
                  className="block w-full rounded-lg border border-gray-700 bg-gray-800 p-2.5 text-sm text-gray-200 outline-none focus:border-blue-500 transition-colors"
                >
                  <option value="client">Client (portal)</option>
                  <option value="admin">Admin (internal team)</option>
                </select>
              </div>
              {editing.role === "client" && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-400">Clients (one or more)</label>
                  <div className="rounded-lg border border-gray-700 bg-gray-800 p-2.5 space-y-1.5 max-h-40 overflow-y-auto">
                    {clients.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm text-gray-200 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editing.client_ids.includes(c.id)}
                          onChange={() =>
                            toggleClientId(c.id, editing.client_ids, (v) => setEditing({ ...editing, client_ids: v }))
                          }
                          className="accent-blue-500"
                        />
                        {c.display_name}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
            <button
              type="submit"
              disabled={busy === "edit" || (editing.role === "client" && editing.client_ids.length === 0)}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 transition-all disabled:opacity-60"
            >
              {busy === "edit" ? "Saving…" : "Save changes"}
            </button>
            <p className="text-[11px] text-gray-500">
              Changes reach the client's portal on their next page load (their session refreshes automatically).
            </p>
          </form>
        )}

        <div className="rounded-xl border border-gray-800 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-gray-900 text-left text-xs uppercase tracking-wider text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 bg-gray-900/40">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-6 text-gray-500 animate-pulse">Loading…</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-gray-500">No users yet.</td></tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 text-gray-200">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        u.role === "admin"
                          ? "bg-indigo-500/15 text-indigo-300"
                          : u.role === "client"
                          ? "bg-blue-500/15 text-blue-300"
                          : "bg-gray-800 text-gray-500 border border-gray-700"
                      }`}>
                        {u.role ?? "no role"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-400">{(u.client_ids ?? []).join(", ") || "—"}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "never"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs ${u.disabled ? "text-red-400" : "text-green-400"}`}>
                        {u.disabled ? "disabled" : "active"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                      <button
                        onClick={() =>
                          setEditing({
                            id: u.id,
                            email: u.email,
                            role: u.role === "admin" ? "admin" : "client",
                            client_ids: u.client_ids ?? [],
                          })
                        }
                        disabled={busy !== null || u.id === myUserId}
                        title={u.id === myUserId ? "You cannot edit your own account" : undefined}
                        className="text-xs text-gray-400 hover:text-blue-300 underline underline-offset-2 disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => resetPassword(u)}
                        disabled={busy !== null}
                        className="text-xs text-gray-400 hover:text-blue-300 underline underline-offset-2 disabled:opacity-50"
                      >
                        Reset password
                      </button>
                      <button
                        onClick={() => toggleDisabled(u)}
                        disabled={busy !== null}
                        className={`text-xs underline underline-offset-2 disabled:opacity-50 ${
                          u.disabled ? "text-gray-400 hover:text-green-300" : "text-gray-400 hover:text-red-300"
                        }`}
                      >
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
