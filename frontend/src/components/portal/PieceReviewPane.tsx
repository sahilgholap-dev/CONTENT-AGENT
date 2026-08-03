"use client";

import { fmtMeta, pieceSizeLine, timeAgo } from "@/components/portal/pieceMeta";

/** Renders a piece as it will read: full text for blogs, social-card for
 *  posts, script format for videos/reels. Shared between the Create
 *  wizard's review step and the Drafts right pane (brief §6). */
export default function PieceReviewPane({
  piece,
  footer,
}: {
  piece: any;
  footer?: React.ReactNode;
}) {
  if (!piece) return null;
  const d = piece.draft ?? {};
  const meta = fmtMeta(piece.format);

  return (
    <div className="min-h-[400px] rounded-xl border border-cs-border bg-white px-10 py-8 shadow-cs">
      <div className="text-[26px] font-bold leading-[1.25] tracking-[-0.5px]">
        {d.seo_title || piece.topic}
      </div>
      <div className="mb-6 mt-1.5 border-b border-cs-border pb-4 text-xs text-cs-muted">
        {meta.label} · Written {timeAgo(piece.created_at || piece.ingested_at)} · {pieceSizeLine(piece)}
      </div>

      {piece.content_type === "long_form" && (
        <div
          className="prose prose-slate max-w-none text-[14.5px] leading-[1.65]"
          dangerouslySetInnerHTML={{ __html: d.body_html ?? "" }}
        />
      )}

      {piece.content_type === "short_form" && (
        <div className="max-w-[560px]">
          <div className="whitespace-pre-wrap text-[14.5px] leading-[1.65]">{d.post_text ?? ""}</div>
          {Array.isArray(d.hashtags) && d.hashtags.length > 0 && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              {d.hashtags.map((h: string, i: number) => (
                <span key={i} className="rounded bg-cs-accent-soft px-2 py-0.5 text-xs font-medium text-cs-accent-deep">
                  {String(h).startsWith("#") ? h : `#${h}`}
                </span>
              ))}
            </div>
          )}
          {d.cta && <div className="mt-4 text-[13px] text-cs-muted">CTA: {d.cta}</div>}
        </div>
      )}

      {piece.content_type === "video" && (
        <div className="space-y-3">
          {(Array.isArray(d.scenes) ? d.scenes : []).map((s: any, i: number) => (
            <div key={i} className="rounded-lg border border-cs-border bg-cs-gray-soft/60 p-4">
              <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-cs-muted">
                Scene {s.scene_no ?? i + 1} · {s.duration_sec ?? "?"}s
              </div>
              <div className="text-[14px] leading-[1.6]">{s.voiceover}</div>
              {s.on_screen_text ? (
                <div className="mt-2 text-[12.5px] text-cs-muted">
                  <span className="font-semibold">On-screen:</span> {s.on_screen_text}
                </div>
              ) : null}
              {s.visual_direction ? (
                <div className="mt-1 text-[12.5px] text-cs-muted">
                  <span className="font-semibold">Visual:</span> {s.visual_direction}
                </div>
              ) : null}
            </div>
          ))}
          {d.video_description && (
            <div className="rounded-lg border border-cs-border p-4 text-[13px] text-cs-muted">
              <span className="font-semibold text-cs-text">Description: </span>
              {d.video_description}
            </div>
          )}
        </div>
      )}

      {footer && (
        <div className="mt-8 flex items-center justify-between gap-3 border-t border-cs-border pt-5">
          <div className="text-[12.5px] text-cs-muted">
            {piece.verification_flags_count > 0
              ? `${piece.verification_flags_count} factual claim${piece.verification_flags_count === 1 ? "" : "s"} flagged for a quick check`
              : "No factual claims flagged"}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
}
