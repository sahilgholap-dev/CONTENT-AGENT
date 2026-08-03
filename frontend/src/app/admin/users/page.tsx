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
    <div className="min-h-screen bg-cs-page">
      <div className="max-w-5xl mx-auto p-8">
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-2xl font-bold text-cs-text">Portal Users</h1>
          <button
            onClick={() => setShowCreate((v) => !v)}
            className="text-xs uppercase font-bold tracking-wider px-3 py-2 bg-cs-accent-soft text-cs-accent border border-cs-accent/40 rounded-lg hover:bg-cs-accent-hover hover:text-white transition-colors"
          >
            + Create Login
          </button>
        </div>
        <p className="text-sm text-cs-muted mb-6">
          <Link href="/admin" className="hover:text-cs-text transition-colors">← Back to batches</Link>
          <span className="mx-2">·</span>
          Client logins see only their own content at /portal. Admin logins see everything here.
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-red-200 bg-cs-danger-soft p-3 text-sm text-cs-danger">{error}</div>
        )}

        {credential && (
          <div className="mb-6 rounded-xl border border-emerald-300 bg-cs-emerald-soft p-4">
            <div className="text-sm font-semibold text-emerald-700 mb-1">
              Credentials for {credential.email} — shown once, copy them now
            </div>
            <div className="font-mono text-sm text-cs-text bg-white rounded-lg p-3 flex items-center justify-between gap-4">
              <span>{credential.password}</span>
              <button
                onClick={copyCredential}
                className="text-xs uppercase font-bold tracking-wider px-2 py-1 bg-white text-cs-text border border-cs-border-strong rounded hover:border-cs-light transition-colors shrink-0"
              >
                {copied ? "Copied ✓" : "Copy login + password"}
              </button>
            </div>
            <div className="text-[11px] text-cs-muted mt-2">
              Share these with the client securely. The password is not stored anywhere and cannot be viewed again — only reset.
            </div>
          </div>
        )}

        {showCreate && (
          <form onSubmit={createUser} className="mb-6 rounded-xl border border-cs-border bg-white p-5 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-cs-muted">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="client@example.com"
                  className="block w-full rounded-lg border border-cs-border-strong bg-white p-2.5 text-sm text-cs-text outline-none focus:border-cs-accent transition-colors"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-cs-muted">Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as "client" | "admin")}
                  className="block w-full rounded-lg border border-cs-border-strong bg-white p-2.5 text-sm text-cs-text outline-none focus:border-cs-accent transition-colors"
                >
                  <option value="client">Client (portal)</option>
                  <option value="admin">Admin (internal team)</option>
                </select>
              </div>
              {role === "client" && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-cs-muted">Clients (one or more)</label>
                  <div className="rounded-lg border border-cs-border-strong bg-white p-2.5 space-y-1.5 max-h-40 overflow-y-auto">
                    {clients.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm text-cs-text cursor-pointer">
                        <input
                          type="checkbox"
                          checked={clientIds.includes(c.id)}
                          onChange={() => toggleClientId(c.id, clientIds, setClientIds)}
                          className="accent-cs-accent"
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
              className="rounded-lg bg-cs-accent px-4 py-2 text-sm font-semibold text-cs-text hover:bg-cs-accent-hover transition-all disabled:opacity-60"
            >
              {busy === "create" ? "Creating…" : "Create login & generate password"}
            </button>
          </form>
        )}

        {editing && (
          <form onSubmit={saveEdit} className="mb-6 rounded-xl border border-cs-accent/40 bg-white p-5 space-y-4">
            <div className="text-sm font-semibold text-cs-text">
              Edit {editing.email}
              <button
                type="button"
                onClick={() => setEditing(null)}
                className="float-right text-cs-muted hover:text-cs-text transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-cs-muted">Role</label>
                <select
                  value={editing.role}
                  onChange={(e) => setEditing({ ...editing, role: e.target.value as "client" | "admin" })}
                  className="block w-full rounded-lg border border-cs-border-strong bg-white p-2.5 text-sm text-cs-text outline-none focus:border-cs-accent transition-colors"
                >
                  <option value="client">Client (portal)</option>
                  <option value="admin">Admin (internal team)</option>
                </select>
              </div>
              {editing.role === "client" && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-cs-muted">Clients (one or more)</label>
                  <div className="rounded-lg border border-cs-border-strong bg-white p-2.5 space-y-1.5 max-h-40 overflow-y-auto">
                    {clients.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-sm text-cs-text cursor-pointer">
                        <input
                          type="checkbox"
                          checked={editing.client_ids.includes(c.id)}
                          onChange={() =>
                            toggleClientId(c.id, editing.client_ids, (v) => setEditing({ ...editing, client_ids: v }))
                          }
                          className="accent-cs-accent"
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
              className="rounded-lg bg-cs-accent px-4 py-2 text-sm font-semibold text-cs-text hover:bg-cs-accent-hover transition-all disabled:opacity-60"
            >
              {busy === "edit" ? "Saving…" : "Save changes"}
            </button>
            <p className="text-[11px] text-cs-muted">
              Changes reach the client's portal on their next page load (their session refreshes automatically).
            </p>
          </form>
        )}

        <div className="rounded-xl border border-cs-border overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-white text-left text-xs uppercase tracking-wider text-cs-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Last sign-in</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-cs-border bg-white">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-6 text-cs-muted animate-pulse">Loading…</td></tr>
              ) : users.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-cs-muted">No users yet.</td></tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 text-cs-text">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        u.role === "admin"
                          ? "bg-cs-accent-soft text-cs-accent-deep"
                          : u.role === "client"
                          ? "bg-cs-accent/15 text-cs-accent"
                          : "bg-white text-cs-muted border border-cs-border-strong"
                      }`}>
                        {u.role ?? "no role"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-cs-muted">{(u.client_ids ?? []).join(", ") || "—"}</td>
                    <td className="px-4 py-3 text-cs-muted text-xs">
                      {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "never"}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs ${u.disabled ? "text-cs-danger" : "text-emerald-600"}`}>
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
                        className="text-xs text-cs-muted hover:text-cs-accent underline underline-offset-2 disabled:opacity-50"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => resetPassword(u)}
                        disabled={busy !== null}
                        className="text-xs text-cs-muted hover:text-cs-accent underline underline-offset-2 disabled:opacity-50"
                      >
                        Reset password
                      </button>
                      <button
                        onClick={() => toggleDisabled(u)}
                        disabled={busy !== null}
                        className={`text-xs underline underline-offset-2 disabled:opacity-50 ${
                          u.disabled ? "text-cs-muted hover:text-emerald-700" : "text-cs-muted hover:text-red-700"
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
