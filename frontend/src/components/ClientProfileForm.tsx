import React, { useState } from "react";
import { apiFetch } from "@/lib/api";

/* The hybrid profile: fixed keys, freeform team-authored text values.
   Field keys mirror the backend ClientProfile model (profile.py). */

const CORE_FIELDS = [
  { key: "voice", label: "Brand Voice", help: "Who the client is, their audience, tone and voice. Injected into topic discovery and drafting." },
  { key: "compliance_rules", label: "Compliance Rules", help: "The per-check rule list the compliance gate enforces (PASS/FAIL wording included). Strictly client-specific." },
  { key: "requirements", label: "Content Requirements", help: "What this client needs from its content. Appended to the voice context when non-empty." },
  { key: "special_instructions", label: "Special Instructions", help: "Client-specific dos and don'ts. Appended to the voice context when non-empty." },
];

const PIPELINE_FIELDS = [
  { key: "topic_discovery_playbook", label: "Topic Discovery Playbook", help: "Full discovery procedure: acceptance test, dedupe queries, seed queries, reference sources, topic shapes, reject filters." },
  { key: "competitor_refs", label: "Competitor Reference Tiers", help: "Competitor/reference site tiers for SERP analysis." },
  { key: "content_skeletons", label: "Content-Type Skeletons", help: "Content-type classification plus write-order and per-type middle sections." },
  { key: "word_count_rules", label: "Word Count Rules", help: "Hard floor / target range bullets for the drafter." },
  { key: "self_scan_rules", label: "Drafter Self-Scans", help: "Mandatory pre-final self-scans (banned phrases, style bans, JSON quote safety). Keep the quote-safety scan — output must stay valid JSON." },
  { key: "eeat_guidance", label: "E-E-A-T Persona Guidance", help: "The expert-persona block driving first-hand-detail writing." },
  { key: "first_use_definitions", label: "First-Use Definitions", help: "Terms the drafter must define verbatim on first use (one structural bullet)." },
  { key: "mandatory_language", label: "Mandatory Legal Language", help: "Verbatim disclosure / disclaimer / responsible-use blocks (A/B/C)." },
  { key: "banned_phrases", label: "Banned Phrases", help: "Bullet list of phrases that must never appear." },
  { key: "seo_prechecks", label: "SEO Gate Pre-Checks", help: "Automatic-fail pre-checks for the SEO/quality gate (style bans, word floor)." },
  { key: "body_completeness_rule", label: "Body Completeness Marker", help: "How the assembler verifies body_html is complete (e.g. required closing text)." },
];

const PERSONA_FIELDS = [
  { key: "research_backstory", label: "Research Specialist Backstory" },
  { key: "drafter_backstory", label: "Drafter Backstory" },
  { key: "drafter_goal_persona", label: "Drafter Goal Persona" },
  { key: "compliance_backstory", label: "Compliance Checker Backstory" },
  { key: "seo_checker_backstory", label: "SEO Checker Backstory" },
  { key: "discovery_role", label: "Discovery Agent Role" },
  { key: "discovery_goal", label: "Discovery Agent Goal" },
  { key: "discovery_backstory", label: "Discovery Agent Backstory" },
];

const LEXICON_FIELDS = [
  { key: "domain_noun", label: "Domain noun (lowercase)", example: "casino" },
  { key: "domain_title", label: "Domain noun (title case)", example: "Casino" },
  { key: "keyword_domain", label: "Keyword domain", example: "casino/gambling" },
  { key: "content_domain_hyph", label: "Content domain (hyphenated)", example: "casino-content" },
  { key: "high_risk_claim_types", label: "High-risk claim types", example: "bonus amounts, licensing, payout speed, or legality" },
  { key: "compliance_risk_hint", label: "Compliance-risk scoring hint", example: "how much RG/legal/bonus caution is needed" },
];

export function emptyProfile(): Record<string, any> {
  const profile: Record<string, any> = { learned_style: "", pillar_taxonomy: [], personas: {}, lexicon: {} };
  for (const f of [...CORE_FIELDS, ...PIPELINE_FIELDS]) profile[f.key] = "";
  for (const f of PERSONA_FIELDS) profile.personas[f.key] = "";
  for (const f of LEXICON_FIELDS) profile.lexicon[f.key] = "";
  return profile;
}

function TextArea({
  label,
  help,
  value,
  onChange,
  rows = 6,
}: {
  label: string;
  help?: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <div>
      <label className="block text-sm font-semibold text-gray-300">{label}</label>
      {help && <p className="text-xs text-gray-500 mt-0.5 mb-2">{help}</p>}
      <textarea
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2.5 outline-none transition-colors font-mono"
      />
    </div>
  );
}

function Section({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-800 rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3 bg-gray-900 text-left"
      >
        <span className="text-sm font-bold text-gray-300 uppercase tracking-wider">{title}</span>
        <span className="text-gray-500">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="p-4 space-y-5 bg-gray-950">{children}</div>}
    </div>
  );
}

/** Rendered with a key per client (or "__new__"), so state initialises from
 *  the `client` prop on mount — no props→state sync effect needed. */
export default function ClientProfileForm({
  client, // null => create mode
  onSaved,
}: {
  client: Record<string, any> | null;
  onSaved: () => void;
}) {
  const isNew = !client;
  const [displayName, setDisplayName] = useState<string>(() => client?.display_name ?? "");
  const [siteDomain, setSiteDomain] = useState<string>(() => client?.site_domain ?? "");
  const [status, setStatus] = useState<string>(() => client?.status ?? "active");
  const [profile, setProfile] = useState<Record<string, any>>(() => {
    const base = emptyProfile();
    const p = client?.profile ?? {};
    return {
      ...base,
      ...p,
      personas: { ...base.personas, ...(p.personas ?? {}) },
      lexicon: { ...base.lexicon, ...(p.lexicon ?? {}) },
    };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  const setField = (key: string, value: any) => setProfile((p) => ({ ...p, [key]: value }));
  const setPersona = (key: string, value: string) =>
    setProfile((p) => ({ ...p, personas: { ...p.personas, [key]: value } }));
  const setLexicon = (key: string, value: string) =>
    setProfile((p) => ({ ...p, lexicon: { ...p.lexicon, [key]: value } }));

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSavedMsg(null);
    try {
      const body = {
        display_name: displayName,
        site_domain: siteDomain,
        status,
        profile,
      };
      const res = await apiFetch(isNew ? "/api/clients" : `/api/clients/${encodeURIComponent(client!.id)}`, {
        method: isNew ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail ?? data));
      } else {
        setSavedMsg(
          isNew ? `Client '${data.id}' created (profile v${data.profile_version}).`
                : `Saved — profile is now v${data.profile_version}. Runs in flight keep their pinned version.`
        );
        onSaved();
      }
    } catch (e: any) {
      setError("Failed to reach server: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2.5 outline-none transition-colors";

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-semibold text-gray-300 mb-2">Client Name</label>
          <input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Acme Fintech" />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-300 mb-2">Site Domain</label>
          <input className={inputClass} value={siteDomain} onChange={(e) => setSiteDomain(e.target.value)} placeholder="acme.com" />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-300 mb-2">Status</label>
          <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="archived">archived</option>
          </select>
        </div>
      </div>

      <Section title="Client Profile (core)" defaultOpen>
        {CORE_FIELDS.map((f) => (
          <TextArea key={f.key} label={f.label} help={f.help} value={profile[f.key]} onChange={(v) => setField(f.key, v)} rows={f.key === "voice" || f.key === "compliance_rules" ? 10 : 4} />
        ))}
        <div>
          <label className="block text-sm font-semibold text-gray-300">Pillar Taxonomy</label>
          <p className="text-xs text-gray-500 mt-0.5 mb-2">One pillar per line (content categories, e.g. reviews / guides).</p>
          <textarea
            value={(profile.pillar_taxonomy ?? []).join("\n")}
            onChange={(e) => setField("pillar_taxonomy", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))}
            rows={5}
            className="w-full bg-gray-800 border border-gray-700 text-gray-200 text-sm rounded-lg focus:ring-blue-500 focus:border-blue-500 p-2.5 outline-none transition-colors font-mono"
          />
        </div>
      </Section>

      <Section title="Pipeline Configuration (advanced)">
        {PIPELINE_FIELDS.map((f) => (
          <TextArea key={f.key} label={f.label} help={f.help} value={profile[f.key]} onChange={(v) => setField(f.key, v)} rows={f.key === "topic_discovery_playbook" ? 14 : 6} />
        ))}
      </Section>

      <Section title="Agent Personas (advanced)">
        {PERSONA_FIELDS.map((f) => (
          <TextArea key={f.key} label={f.label} value={profile.personas?.[f.key] ?? ""} onChange={(v) => setPersona(f.key, v)} rows={5} />
        ))}
      </Section>

      <Section title="Lexicon (advanced)">
        <p className="text-xs text-gray-500 -mb-2">
          Short domain fragments injected into otherwise-generic prompt sentences.
        </p>
        {LEXICON_FIELDS.map((f) => (
          <div key={f.key}>
            <label className="block text-sm font-semibold text-gray-300 mb-2">
              {f.label} <span className="text-gray-600 font-normal">(e.g. “{f.example}”)</span>
            </label>
            <input className={inputClass} value={profile.lexicon?.[f.key] ?? ""} onChange={(e) => setLexicon(f.key, e.target.value)} />
          </div>
        ))}
      </Section>

      {profile.learned_style ? (
        <Section title="Learned Style (from approvals)">
          <p className="text-xs text-gray-500 -mb-2">Distilled from this client's approved content. Managed by the learning loop.</p>
          <TextArea label="Learned Style Addendum" value={profile.learned_style} onChange={(v) => setField("learned_style", v)} rows={6} />
        </Section>
      ) : null}

      {error && <div className="p-3 bg-red-900/20 border border-red-900/50 rounded-lg text-red-400 text-sm whitespace-pre-wrap">{error}</div>}
      {savedMsg && <div className="p-3 bg-green-900/20 border border-green-900/50 rounded-lg text-green-400 text-sm">{savedMsg}</div>}

      <div className="flex justify-end gap-3">
        <button
          onClick={handleSave}
          disabled={saving || !displayName.trim() || !siteDomain.trim()}
          className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg shadow-lg shadow-blue-500/20 transition-all border border-blue-400/20 active:scale-95"
        >
          {saving ? "Saving…" : isNew ? "Create Client" : "Save (new profile version)"}
        </button>
      </div>
    </div>
  );
}
