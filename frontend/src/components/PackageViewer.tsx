import React, { useState } from "react";
import FeedbackBar from "./FeedbackBar";

const TABS = [
  { id: "draft", label: "Draft" },
  { id: "compliance", label: "Compliance" },
  { id: "seo", label: "SEO Quality" },
  { id: "brief", label: "SEO Brief" },
  { id: "facts", label: "Fact Store" },
  { id: "meta", label: "Metadata" },
  { id: "raw", label: "Raw JSON" },
];

const Pill = ({ children, type }: { children: React.ReactNode; type?: string }) => {
  let colorClass = "bg-gray-800 text-gray-300";
  const t = String(children || type).toUpperCase();
  if (t === "PASS" || t === "VERIFIED" || t === "OK") colorClass = "bg-green-500/15 text-green-400";
  if (t === "FAIL" || t === "REVIEW" || t === "REQUIRED" || t === "HIGH") colorClass = "bg-red-500/15 text-red-400";
  if (t === "INFERRED" || t === "MEDIUM") colorClass = "bg-yellow-500/15 text-yellow-400";
  if (t === "LOW") colorClass = "bg-blue-500/15 text-blue-400";
  
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-bold uppercase tracking-wider ${colorClass}`}>
      {children}
    </span>
  );
};

export default function PackageViewer({ pkg }: { pkg: Record<string, any> }) {
  const [activeTab, setActiveTab] = useState("draft");

  const renderTabContent = () => {
    switch (activeTab) {
      case "draft":
        return <DraftView draft={pkg.draft as Record<string, any>} topic={pkg.topic as string} />;
      case "compliance":
        return <ComplianceView data={pkg.compliance_scorecard as Record<string, any>} />;
      case "seo":
        return <SeoView data={pkg.seo_quality_scorecard as Record<string, any>} />;
      case "brief":
        return <BriefView data={pkg.seo_brief as Record<string, any>} />;
      case "facts":
        return <FactsView data={pkg.fact_store as Record<string, any>} />;
      case "meta":
        return <MetaView pkg={pkg} />;
      case "raw":
        return (
          <div className="bg-gray-900 rounded-xl border border-gray-800 p-4 overflow-auto text-xs text-gray-300 font-mono">
            <pre>{JSON.stringify(pkg, null, 2)}</pre>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="max-w-5xl mx-auto pb-12">
      <FeedbackBar key={(pkg.package_id as string) || "none"} pkg={pkg} />
      <div className="flex flex-wrap gap-2 mb-6">
        {TABS.map((tab) => {
          if (
            (tab.id === "draft" && !pkg.draft) ||
            (tab.id === "compliance" && !pkg.compliance_scorecard) ||
            (tab.id === "seo" && !pkg.seo_quality_scorecard) ||
            (tab.id === "brief" && !pkg.seo_brief) ||
            (tab.id === "facts" && !pkg.fact_store)
          ) {
            return null;
          }

          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                isActive
                  ? "bg-blue-600 text-white shadow-lg shadow-blue-500/20"
                  : "bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-200 border border-gray-700"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-6">{renderTabContent()}</div>
    </div>
  );
}

function DraftView({ draft, topic }: { draft: Record<string, any>; topic: string }) {
  if (!draft) return null;
  const links = (draft.internal_links as any[]) || [];
  const vf = (draft.verification_flags as any[]) || [];
  const sn = (draft.source_notes as any[]) || [];
  
  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
        <h2 className="text-xl font-bold text-white mb-6 pb-4 border-b border-gray-800">
          {draft.seo_title || topic || "Draft"}
        </h2>
        <div className="grid grid-cols-[180px_1fr] gap-y-4 gap-x-6 text-sm">
          <div className="text-gray-500 font-medium">Slug</div><div className="text-gray-300">{draft.slug || "—"}</div>
          <div className="text-gray-500 font-medium">Category</div><div className="text-gray-300">{draft.category || "—"}</div>
          <div className="text-gray-500 font-medium">Meta Description</div><div className="text-gray-300">{draft.meta_description || "—"}</div>
          <div className="text-gray-500 font-medium">Excerpt</div><div className="text-gray-300">{draft.excerpt || "—"}</div>
          <div className="text-gray-500 font-medium">Tags</div>
          <div className="text-gray-300">
            {((draft.tags as string[]) || []).length > 0 
              ? (draft.tags as string[]).map(t => <span key={t} className="inline-block bg-gray-800 border border-gray-700 rounded-md px-2 py-1 mr-2 text-xs">{t}</span>)
              : "—"}
          </div>
          <div className="text-gray-500 font-medium">Featured Image Prompt</div><div className="text-gray-300">{draft.featured_image_prompt || "—"}</div>
          <div className="text-gray-500 font-medium">Responsible Gambling</div><div className="text-gray-300">{draft.responsible_gambling_note || "—"}</div>
          <div className="text-gray-500 font-medium">Internal Links</div>
          <div className="text-gray-300">
            {links.length > 0 ? (
              <div className="space-y-1">
                {links.map((l: any, i: number) => (
                  <a key={i} href={l.target_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline block truncate">{l.anchor}</a>
                ))}
              </div>
            ) : "—"}
          </div>
        </div>
      </div>

      {vf.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
          <h3 className="text-lg font-bold text-white mb-4">Verification Flags in Draft</h3>
          <div className="space-y-3">
            {vf.map((f: any, i: number) => (
              <div key={i} className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-sm">
                <strong className="block text-yellow-500 mb-1">{f.location_in_draft || ""}</strong>
                <span className="text-gray-300">{f.flag || f}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {draft.body_html && (
        <div className="bg-white text-gray-900 border border-gray-200 rounded-xl p-8 shadow-sm prose prose-blue max-w-none">
          <div dangerouslySetInnerHTML={{ __html: draft.body_html }} />
        </div>
      )}

      {sn.length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
          <h3 className="text-lg font-bold text-white mb-4">Source Notes</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-gray-400 uppercase bg-gray-800/50">
                <tr><th className="px-4 py-3">Claim</th><th className="px-4 py-3">Confidence</th><th className="px-4 py-3">Source</th></tr>
              </thead>
              <tbody>
                {sn.map((s: any, i: number) => (
                  <tr key={i} className="border-b border-gray-800/50">
                    <td className="px-4 py-3 text-gray-200">{s.claim}</td>
                    <td className="px-4 py-3"><Pill>{s.confidence}</Pill></td>
                    <td className="px-4 py-3"><a href={s.source_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">{s.source_url}</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function renderInstr(ri: any) {
  if (ri == null) return null;
  if (typeof ri === 'string') return <p className="text-gray-300 text-sm">{ri}</p>;
  if (Array.isArray(ri)) return <ul className="list-disc pl-5 text-gray-300 text-sm space-y-1">{ri.map((x, i) => <li key={i}>{typeof x === 'string' ? x : JSON.stringify(x)}</li>)}</ul>;
  return (
    <div className="space-y-4">
      {Object.entries(ri).map(([k, v], idx) => {
        if (Array.isArray(v)) {
          return (
            <div key={idx}>
              <strong className="text-gray-200 text-sm block mb-1">{k}</strong>
              <ul className="list-disc pl-5 text-gray-300 text-sm space-y-1">
                {v.map((x: any, i: number) => <li key={i}>{typeof x === 'string' ? x : (x.improvement ?? x.dimension ?? JSON.stringify(x))}</li>)}
              </ul>
            </div>
          );
        }
        return <p key={idx} className="text-gray-300 text-sm"><strong className="text-gray-200">{k}:</strong> {String(v)}</p>;
      })}
    </div>
  );
}

function ComplianceView({ data }: { data: Record<string, any> }) {
  if (!data) return null;
  const checks = (data.checks as any[]) || [];
  const failCount = checks.filter(c => String(c.verdict || c.result).toUpperCase() === 'FAIL').length;
  
  const blockingFailures = (data.blocking_failures as any[]) || [];
  const simpleBlocking = blockingFailures.filter(b => typeof b === 'string' || (!b.violation && !b.remediation));
  const detailedBlocking = blockingFailures.filter(b => typeof b !== 'string' && (b.violation || b.remediation));

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
        <div className="flex items-center space-x-3 mb-2">
          <h2 className="text-xl font-bold text-white">Overall Verdict</h2>
          <Pill>{data.overall_verdict}</Pill>
        </div>
        
        {simpleBlocking.length > 0 && (
          <div className="text-sm text-gray-400 mt-2">
            Blocking failures: {simpleBlocking.map((b, i) => {
              const label = typeof b === 'string' 
                ? b 
                : (b.check_name ?? b.item ?? b.check ?? b.name ?? JSON.stringify(b));
              const sev = (typeof b !== 'string' && b.severity) ? ` (${b.severity})` : '';
              return (
                <span key={i} className="inline-block bg-gray-800 border border-gray-700 rounded-md px-2 py-0.5 mr-2 text-xs text-gray-300 mb-1">
                  {label}{sev}
                </span>
              );
            })}
          </div>
        )}
        
        {blockingFailures.length === 0 && (
          <div className="text-sm text-gray-400 mt-2">Blocking failures: none</div>
        )}
        
        <div className="text-sm text-gray-400 mt-1">{checks.length} checks • {failCount} failing</div>
      </div>

      {detailedBlocking.length > 0 && (
        <div className="bg-gray-900 border border-red-900/30 rounded-xl p-6 shadow-sm space-y-4">
          <h3 className="text-lg font-bold text-red-400">Detailed Blocking Failures</h3>
          {detailedBlocking.map((b, i) => (
            <div key={i} className="bg-red-500/5 border border-red-500/20 rounded-lg p-4 text-sm">
              <div className="font-bold text-red-400 mb-2">
                {b.check_name ?? b.item ?? b.check ?? b.name ?? "Unknown Check"}
                {b.severity && <span className="ml-2 bg-red-500/20 text-red-300 px-2 py-0.5 rounded text-xs">{b.severity}</span>}
              </div>
              {b.violation && (
                <div className="mb-2">
                  <span className="font-semibold text-gray-300">Violation: </span>
                  <span className="text-red-300 italic">&ldquo;{b.violation}&rdquo;</span>
                </div>
              )}
              {b.remediation && (
                <div>
                  <span className="font-semibold text-gray-300">Remediation: </span>
                  <span className="text-blue-300">→ {b.remediation}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-gray-400 uppercase bg-gray-800/50">
            <tr><th className="px-4 py-3">Check</th><th className="px-4 py-3">Verdict</th><th className="px-4 py-3">Severity</th><th className="px-4 py-3">Details</th></tr>
          </thead>
          <tbody>
            {checks.map((c: any, i: number) => {
              const name = c.check_name ?? c.item ?? c.check ?? c.check_item ?? c.name ?? c.dimension ?? "Unknown";
              const verdict = c.verdict ?? c.result ?? "";
              const off = c.offending_text ?? c.offendingText ?? c.violation ?? c.details ?? "";
              const rem = c.remediation ?? c.note ?? c.fix ?? "";
              return (
                <tr key={i} className="border-b border-gray-800/50">
                  <td className="px-4 py-4 font-medium text-gray-200">{name}</td>
                  <td className="px-4 py-4"><Pill>{verdict}</Pill></td>
                  <td className="px-4 py-4">{c.severity ? <Pill>{c.severity}</Pill> : "—"}</td>
                  <td className="px-4 py-4 text-gray-400">
                    {off && <div className="text-red-300 mb-1 italic">&ldquo;{off}&rdquo;</div>}
                    {rem && <div className="text-blue-300">→ {rem}</div>}
                    {!off && !rem && "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      
      {data.revision_instructions && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
          <h3 className="text-lg font-bold text-white mb-4">Revision Instructions</h3>
          {renderInstr(data.revision_instructions)}
        </div>
      )}
    </div>
  );
}

function SeoView({ data }: { data: Record<string, any> }) {
  if (!data) return null;
  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <h2 className="text-xl font-bold text-white">SEO Quality</h2>
          <Pill>{data.overall_verdict}</Pill>
        </div>
        {data.overall_score != null && (
          <div className="text-3xl font-black text-gray-200">{data.overall_score}<span className="text-sm text-gray-500 font-normal">/10</span></div>
        )}
      </div>
      
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm space-y-6">
        {((data.dimensions as any[]) || []).map((d: any, i: number) => {
          const dn = d.dimension ?? d.name ?? '';
          return (
            <div key={i}>
              <div className="flex items-center space-x-3 mb-2">
                <span className="font-semibold text-gray-200">{dn}</span>
                <Pill>{d.verdict}</Pill>
                <span className="text-xs text-gray-500 ml-auto">{d.score}/10</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2 mb-2 overflow-hidden">
                <div className="bg-blue-500 h-full rounded-full" style={{ width: `${(d.score || 0) * 10}%` }}></div>
              </div>
              <p className="text-sm text-gray-400">{d.notes}</p>
            </div>
          )
        })}
      </div>

      {data.revision_instructions && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
          <h3 className="text-lg font-bold text-white mb-4">Revision Instructions</h3>
          {renderInstr(data.revision_instructions)}
        </div>
      )}
    </div>
  );
}

function BriefView({ data }: { data: Record<string, any> }) {
  if (!data) return null;
  const ks = data.keyword_scores || {};
  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
        <h2 className="text-xl font-bold text-white mb-6 pb-4 border-b border-gray-800">SEO Brief</h2>
        <div className="grid grid-cols-[180px_1fr] gap-y-4 gap-x-6 text-sm">
          <div className="text-gray-500 font-medium">Primary Keyword</div><div className="text-gray-200 font-semibold">{data.primary_keyword}</div>
          <div className="text-gray-500 font-medium">Search Intent</div><div className="text-gray-300">{data.search_intent}</div>
          <div className="text-gray-500 font-medium">Reader Persona</div><div className="text-gray-300">{data.reader_persona}</div>
          <div className="text-gray-500 font-medium">Word Count Target</div><div className="text-gray-300">{data.word_count_target}</div>
          <div className="text-gray-500 font-medium">Secondary Keywords</div>
          <div className="text-gray-300">
            {((data.secondary_keywords as string[]) || []).map(k => <span key={k} className="inline-block bg-gray-800 border border-gray-700 rounded-md px-2 py-1 mr-2 mb-1 text-xs">{k}</span>)}
          </div>
          <div className="text-gray-500 font-medium">Schema</div><div className="text-gray-300">{data.schema_recommendation}</div>
          <div className="text-gray-500 font-medium">Selection Rationale</div><div className="text-gray-300">{data.selection_rationale}</div>
        </div>
      </div>

      {Object.keys(ks).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
          <h3 className="text-lg font-bold text-white mb-4">Keyword Scores</h3>
          <div className="grid grid-cols-[180px_1fr] gap-y-2 gap-x-6 text-sm">
            {Object.entries(ks).map(([k, v]) => (
              <React.Fragment key={k}>
                <div className="text-gray-500 capitalize">{k.replace(/_/g, " ")}</div>
                <div className="text-gray-300">{String(v)}</div>
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {((data.outline as any[]) || []).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
          <h3 className="text-lg font-bold text-white mb-4">Outline</h3>
          <div className="space-y-2">
            {(data.outline as any[]).map((o: any, i: number) => (
              <details key={i} className="group bg-gray-800/30 rounded-lg">
                <summary className="p-3 font-semibold text-gray-200 cursor-pointer select-none">{o.h2}</summary>
                <div className="p-3 pt-0 text-sm text-gray-400">
                  {((o.h3s as any[]) || []).length > 0 ? (
                    <ul className="list-disc pl-5 space-y-1">
                      {(o.h3s as any[]).map((h, j) => <li key={j}>{h}</li>)}
                    </ul>
                  ) : "No subheadings"}
                </div>
              </details>
            ))}
          </div>
        </div>
      )}

      {((data.faq_set as any[]) || []).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
          <h3 className="text-lg font-bold text-white mb-4">FAQ Set</h3>
          <div className="space-y-3">
            {(data.faq_set as any[]).map((f: any, i: number) => (
              <div key={i} className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4 text-sm">
                <strong className="block text-gray-200 mb-1">{f.question}</strong>
                <span className="text-gray-400">{f.answer_angle}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {((data.title_options as string[]) || []).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
          <h3 className="text-lg font-bold text-white mb-4">Title Options</h3>
          <ul className="list-disc pl-5 text-sm text-gray-300 space-y-1">
            {(data.title_options as string[]).map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </div>
      )}

      {((data.meta_description_options as string[]) || []).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm mt-6">
          <h3 className="text-lg font-bold text-white mb-4">Meta Description Options</h3>
          <ul className="list-disc pl-5 text-sm text-gray-300 space-y-1">
            {(data.meta_description_options as string[]).map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </div>
      )}
      
      {((data.compliance_checklist as any[]) || []).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm mt-6">
          <h3 className="text-lg font-bold text-white mb-4">Compliance Checklist</h3>
          <ul className="list-disc pl-5 text-sm text-gray-300 space-y-2">
            {(data.compliance_checklist as any[]).map((c, i) => (
              <li key={i}>
                {c.item} {c.required && <Pill>Required</Pill>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {((data.competitor_gaps as string[]) || []).length > 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm mt-6">
          <h3 className="text-lg font-bold text-white mb-4">Competitor Gaps</h3>
          <ul className="list-disc pl-5 text-sm text-gray-300 space-y-1">
            {(data.competitor_gaps as string[]).map((g, i) => <li key={i}>{g}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function FactsView({ data }: { data: Record<string, any> }) {
  if (!data) return null;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm overflow-x-auto">
      <h2 className="text-xl font-bold text-white mb-6 pb-4 border-b border-gray-800">
        Fact Store {data.topic ? `— ${data.topic}` : ""}
      </h2>
      <table className="w-full text-sm text-left">
        <thead className="text-xs text-gray-400 uppercase bg-gray-800/50">
          <tr><th className="px-4 py-3">Fact</th><th className="px-4 py-3">Confidence</th><th className="px-4 py-3">Flag</th><th className="px-4 py-3">Source</th></tr>
        </thead>
        <tbody>
          {((data.facts as any[]) || []).map((f: any, i: number) => (
            <tr key={i} className="border-b border-gray-800/50">
              <td className="px-4 py-4 text-gray-200 font-medium">{f.fact}</td>
              <td className="px-4 py-4"><Pill>{f.confidence}</Pill></td>
              <td className="px-4 py-4">{f.flag_for_human ? <Pill type="REVIEW">Review</Pill> : <Pill type="OK">OK</Pill>}</td>
              <td className="px-4 py-4"><a href={f.source_url} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">{f.source_url}</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MetaView({ pkg }: { pkg: Record<string, any> }) {
  const vf = (pkg.verification_flags as any[]) || [];
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 shadow-sm">
      <h2 className="text-xl font-bold text-white mb-6 pb-4 border-b border-gray-800">Package Metadata</h2>
      <div className="grid grid-cols-[180px_1fr] gap-y-4 gap-x-6 text-sm">
        <div className="text-gray-500 font-medium">Package ID</div><div className="text-gray-300 font-mono text-xs">{pkg.package_id || "—"}</div>
        <div className="text-gray-500 font-medium">Topic</div><div className="text-gray-300">{pkg.topic || "—"}</div>
        <div className="text-gray-500 font-medium">Primary Keyword</div><div className="text-gray-300">{pkg.primary_keyword || "—"}</div>
        <div className="text-gray-500 font-medium">Pillar</div><div className="text-gray-300">{pkg.pillar || "—"}</div>
        <div className="text-gray-500 font-medium">Created At</div><div className="text-gray-300">{pkg.created_at || "—"}</div>
        <div className="text-gray-500 font-medium">Revision Count</div><div className="text-gray-300">{pkg.revision_count ?? "—"}</div>
        <div className="text-gray-500 font-medium">Review Status</div><div>{pkg.review_status ? <Pill type="INFERRED">{pkg.review_status}</Pill> : "—"}</div>
        <div className="text-gray-500 font-medium">Escalation Reason</div><div className="text-gray-300">{pkg.escalation_reason || "—"}</div>
        <div className="text-gray-500 font-medium">Reviewer Notes</div><div className="text-gray-300">{pkg.reviewer_notes || "—"}</div>
        <div className="text-gray-500 font-medium">Verification Flags</div>
        <div>
          {vf.length > 0 ? (
            <div className="space-y-2">
              {vf.map((f, i) => (
                <div key={i} className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-2 text-xs text-yellow-500">
                  {f.flag || f}
                </div>
              ))}
            </div>
          ) : "—"}
        </div>
      </div>
    </div>
  );
}
