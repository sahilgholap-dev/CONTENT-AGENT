"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api";

type ContentType = { id: string; label: string; sort_order: number };
type Format = {
  id: string;
  content_type: string;
  label: string;
  description: string;
  enabled: boolean;
  task_variant: string;
  pipeline: Record<string, any>;
  stage_labels: string[];
  sort_order: number;
};

const inputClass =
  "w-full bg-white border border-cs-border-strong text-cs-text text-sm rounded-lg focus:ring-cs-accent-soft focus:border-cs-accent p-2 outline-none transition-colors";

export default function RegistryPage() {
  const [contentTypes, setContentTypes] = useState<ContentType[]>([]);
  const [formats, setFormats] = useState<Format[]>([]);
  const [taskVariants, setTaskVariants] = useState<string[]>(["default"]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingFormat, setEditingFormat] = useState<Partial<Format> | null>(null);
  const [newCtLabel, setNewCtLabel] = useState("");

  const load = useCallback(() => {
    apiFetch("/api/registry")
      .then((res) => res.json())
      .then((data) => {
        setContentTypes(data.content_types ?? []);
        setFormats(data.formats ?? []);
        setTaskVariants(data.task_variants ?? ["default"]);
        setLoading(false);
      })
      .catch((err) => {
        console.error(err);
        setError("Failed to load registry");
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const call = async (path: string, method: string, body?: any) => {
    setError(null);
    const res = await apiFetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok && res.status !== 204) {
      const data = await res.json().catch(() => ({}));
      setError(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail ?? data));
      return false;
    }
    load();
    return true;
  };

  const addContentType = async () => {
    if (!newCtLabel.trim()) return;
    if (await call("/api/content-types", "POST", { label: newCtLabel.trim(), sort_order: contentTypes.length })) {
      setNewCtLabel("");
    }
  };

  const deleteContentType = (ct: ContentType) => {
    const n = formats.filter((f) => f.content_type === ct.id).length;
    if (confirm(`Delete content type "${ct.label}"${n ? ` and its ${n} format(s)` : ""}? Past batches keep their labels.`)) {
      call(`/api/content-types/${encodeURIComponent(ct.id)}`, "DELETE");
    }
  };

  const deleteFormat = (f: Format) => {
    if (confirm(`Delete format "${f.label}"? Past batches keep their labels.`)) {
      call(`/api/formats/${encodeURIComponent(f.id)}`, "DELETE");
    }
  };

  const saveFormat = async () => {
    const f = editingFormat!;
    const isNew = !f.id;
    const payload = {
      content_type: f.content_type,
      label: f.label,
      description: f.description ?? "",
      enabled: f.enabled ?? true,
      task_variant: f.task_variant ?? "default",
      pipeline: f.pipeline ?? {},
      stage_labels: f.stage_labels ?? [],
      sort_order: f.sort_order ?? 0,
    };
    const ok = isNew
      ? await call("/api/formats", "POST", payload)
      : await call(`/api/formats/${encodeURIComponent(f.id!)}`, "PUT", payload);
    if (ok) setEditingFormat(null);
  };

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-cs-page">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cs-accent"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-cs-page">
      <div className="max-w-4xl mx-auto p-8">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold text-cs-accent-deep">
            Content Types & Formats
          </h1>
          <Link href="/admin" className="text-xs text-cs-muted hover:text-cs-text transition-colors">
            ← Back to batches
          </Link>
        </div>
        <p className="text-sm text-cs-muted mb-8">
          The catalog the Run Agent modal offers. A format&apos;s <em>pipeline behaviour</em> is set by its task
          variant (code); everything else is editable here. Deleting never touches past batches.
        </p>

        {error && (
          <div className="mb-6 p-3 bg-cs-danger-soft border border-red-200 rounded-lg text-cs-danger text-sm whitespace-pre-wrap">
            {error}
          </div>
        )}

        {/* Content types */}
        <section className="mb-10">
          <h2 className="text-sm font-bold text-cs-text uppercase tracking-wider mb-3">Content Types</h2>
          <div className="space-y-2">
            {contentTypes.map((ct) => (
              <div key={ct.id} className="flex items-center gap-3 bg-white border border-cs-border rounded-lg p-3">
                <span className="text-sm font-semibold text-cs-text">{ct.label}</span>
                <span className="text-[10px] uppercase tracking-wider text-cs-muted font-mono">{ct.id}</span>
                <span className="ml-auto text-xs text-cs-light">
                  {formats.filter((f) => f.content_type === ct.id).length} format(s)
                </span>
                <button
                  onClick={() => deleteContentType(ct)}
                  className="text-xs text-cs-danger/70 hover:text-cs-danger transition-colors"
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <input
              className={inputClass}
              placeholder="New content type label (e.g. Video)"
              value={newCtLabel}
              onChange={(e) => setNewCtLabel(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addContentType()}
            />
            <button
              onClick={addContentType}
              disabled={!newCtLabel.trim()}
              className="px-4 py-2 bg-cs-accent-soft text-cs-accent border border-cs-accent/40 rounded-lg text-sm font-semibold hover:bg-cs-accent-hover hover:text-white disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              + Add
            </button>
          </div>
        </section>

        {/* Formats grouped by content type */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-bold text-cs-text uppercase tracking-wider">Formats</h2>
            <button
              onClick={() =>
                setEditingFormat({
                  content_type: contentTypes[0]?.id ?? "",
                  label: "",
                  description: "",
                  enabled: true,
                  task_variant: "default",
                  pipeline: {},
                  stage_labels: [],
                })
              }
              disabled={contentTypes.length === 0}
              className="text-xs uppercase font-bold tracking-wider px-3 py-1.5 bg-cs-accent-soft text-cs-accent border border-cs-accent/40 rounded hover:bg-cs-accent-hover hover:text-white disabled:opacity-40 transition-colors"
            >
              + New Format
            </button>
          </div>

          {contentTypes.map((ct) => {
            const fmts = formats.filter((f) => f.content_type === ct.id);
            return (
              <div key={ct.id} className="mb-5">
                <div className="text-xs text-cs-muted uppercase tracking-wider mb-2">{ct.label}</div>
                {fmts.length === 0 ? (
                  <div className="text-xs text-cs-light italic pl-1">No formats yet</div>
                ) : (
                  <div className="space-y-2">
                    {fmts.map((f) => (
                      <div key={f.id} className="bg-white border border-cs-border rounded-lg p-3">
                        <div className="flex items-center gap-3">
                          <span className="text-sm font-semibold text-cs-text">{f.label}</span>
                          <span className="text-[10px] uppercase tracking-wider text-cs-muted font-mono">{f.id}</span>
                          <span
                            className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                              f.enabled
                                ? "bg-green-500/15 text-emerald-600"
                                : "bg-white text-cs-muted border border-cs-border-strong"
                            }`}
                          >
                            {f.enabled ? "enabled" : "disabled"}
                          </span>
                          <span className="text-[10px] text-cs-light">variant: {f.task_variant}</span>
                          <div className="ml-auto flex gap-3">
                            <button
                              onClick={() => setEditingFormat({ ...f })}
                              className="text-xs text-cs-accent/80 hover:text-cs-accent transition-colors"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => deleteFormat(f)}
                              className="text-xs text-cs-danger/70 hover:text-cs-danger transition-colors"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        {f.description && <div className="text-xs text-cs-muted mt-1">{f.description}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>

      {editingFormat && (
        <FormatEditor
          value={editingFormat}
          contentTypes={contentTypes}
          taskVariants={taskVariants}
          onChange={setEditingFormat}
          onCancel={() => setEditingFormat(null)}
          onSave={saveFormat}
        />
      )}
    </div>
  );
}

function FormatEditor({
  value,
  contentTypes,
  taskVariants,
  onChange,
  onCancel,
  onSave,
}: {
  value: Partial<Format>;
  contentTypes: ContentType[];
  taskVariants: string[];
  onChange: (v: Partial<Format>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const isNew = !value.id;
  const set = (patch: Partial<Format>) => onChange({ ...value, ...patch });
  const pipe = value.pipeline ?? {};
  const setPipe = (k: string, v: any) => set({ pipeline: { ...pipe, [k]: v } });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-6">
      <div className="w-full max-w-lg bg-cs-page border border-cs-border rounded-xl shadow-2xl p-8 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-bold text-cs-text">{isNew ? "New Format" : `Edit "${value.label}"`}</h2>
          <button onClick={onCancel} className="text-cs-muted hover:text-cs-text text-xl">✕</button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-xs text-cs-muted uppercase tracking-wider mb-2">Content Type</label>
            <select className={inputClass} value={value.content_type ?? ""} onChange={(e) => set({ content_type: e.target.value })}>
              {contentTypes.map((ct) => (
                <option key={ct.id} value={ct.id}>{ct.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-cs-muted uppercase tracking-wider mb-2">Label</label>
            <input className={inputClass} value={value.label ?? ""} onChange={(e) => set({ label: e.target.value })} placeholder="Blog Article" />
            {isNew && <p className="text-[10px] text-cs-light mt-1">The id (slug) is derived from the label.</p>}
          </div>
          <div>
            <label className="block text-xs text-cs-muted uppercase tracking-wider mb-2">Description</label>
            <textarea className={inputClass} rows={2} value={value.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
          </div>
          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm text-cs-text">
              <input type="checkbox" checked={value.enabled ?? true} onChange={(e) => set({ enabled: e.target.checked })} />
              Enabled (offered in Run Agent)
            </label>
            <div className="flex items-center gap-2">
              <span className="text-xs text-cs-muted uppercase tracking-wider">Task variant</span>
              <select
                className="bg-white border border-cs-border-strong text-cs-text text-sm rounded-lg p-2 outline-none"
                value={value.task_variant ?? "default"}
                onChange={(e) => set({ task_variant: e.target.value })}
              >
                {taskVariants.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-[10px] text-cs-light -mt-1">
            Task variant selects the pipeline code. Only variants the crew implements are listed; new pipeline shapes
            need a code change.
          </p>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] text-cs-muted uppercase tracking-wider mb-1">Word floor</label>
              <input type="number" className={inputClass} value={pipe.word_floor ?? ""} onChange={(e) => setPipe("word_floor", e.target.value === "" ? undefined : Number(e.target.value))} />
            </div>
            <div>
              <label className="block text-[10px] text-cs-muted uppercase tracking-wider mb-1">Word max</label>
              <input type="number" className={inputClass} value={pipe.word_target_max ?? ""} onChange={(e) => setPipe("word_target_max", e.target.value === "" ? undefined : Number(e.target.value))} />
            </div>
            <div>
              <label className="block text-[10px] text-cs-muted uppercase tracking-wider mb-1">Pkgs / batch</label>
              <input type="number" className={inputClass} value={pipe.packages_per_batch ?? ""} onChange={(e) => setPipe("packages_per_batch", e.target.value === "" ? undefined : Number(e.target.value))} />
            </div>
          </div>

          <div>
            <label className="block text-xs text-cs-muted uppercase tracking-wider mb-2">Stage Labels (one per line)</label>
            <textarea
              className={inputClass}
              rows={6}
              value={(value.stage_labels ?? []).join("\n")}
              onChange={(e) => set({ stage_labels: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })}
              placeholder={"Topic Discovery\nDrafting\nReview"}
            />
            <p className="text-[10px] text-cs-light mt-1">Drives the progress steps shown in the run terminal.</p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button onClick={onCancel} className="px-4 py-2 text-sm text-cs-muted hover:text-cs-text transition-colors">
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={!value.label?.trim() || !value.content_type}
              className="px-5 py-2 bg-cs-accent hover:bg-cs-accent-hover disabled:opacity-50 text-cs-text text-sm font-semibold rounded-lg transition-all active:scale-95"
            >
              {isNew ? "Create" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
