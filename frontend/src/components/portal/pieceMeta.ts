/** Shared piece helpers for the Content Studio portal: format display
 *  metadata, relative age, and per-platform clipboard formatting. */

export const FORMAT_META: Record<string, { label: string; color: string; group: string }> = {
  blog: { label: "Blog", color: "#6366F1", group: "Blog" },
  linkedin_post: { label: "LinkedIn Post", color: "#3B82F6", group: "Posts" },
  instagram_caption: { label: "Instagram Caption", color: "#3B82F6", group: "Posts" },
  facebook_caption: { label: "Facebook Caption", color: "#3B82F6", group: "Posts" },
  youtube_long: { label: "Video · YouTube", color: "#F59E0B", group: "Videos" },
  youtube_short: { label: "Reel · Shorts", color: "#EF4444", group: "Reels" },
};

export function fmtMeta(format: string | null | undefined) {
  return FORMAT_META[format ?? ""] ?? { label: format ?? "Piece", color: "#94A3B8", group: "Other" };
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  const weeks = Math.round(days / 7);
  return `${weeks} week${weeks === 1 ? "" : "s"} ago`;
}

/** One-line size descriptor for a piece ("1,200 words", "190 chars", "2:40 script"). */
export function pieceSizeLine(piece: any): string {
  const d = piece?.draft ?? {};
  if (piece?.content_type === "long_form") {
    const div = typeof document !== "undefined" ? document.createElement("div") : null;
    if (div) {
      div.innerHTML = d.body_html ?? "";
      const words = (div.textContent ?? "").trim().split(/\s+/).filter(Boolean).length;
      if (words) return `Roughly ${words.toLocaleString()} words · ${Math.max(1, Math.round(words / 220))} minute read`;
    }
    return "Long-form article";
  }
  if (piece?.content_type === "short_form") {
    const chars = (d.post_text ?? "").length;
    return chars ? `${chars} characters` : "Social post";
  }
  const scenes = Array.isArray(d.scenes) ? d.scenes : [];
  const secs = d.total_duration_sec ?? scenes.reduce((s: number, sc: any) => s + (Number(sc?.duration_sec) || 0), 0);
  if (secs) return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")} script`;
  return "Video script";
}

/** Clipboard text formatted for the piece's target platform. */
export function pieceClipboardText(piece: any): string {
  const d = piece?.draft ?? {};
  if (piece?.content_type === "long_form") {
    const div = document.createElement("div");
    div.innerHTML = d.body_html ?? "";
    let text = "";
    div.querySelectorAll("h1,h2,h3,p,li").forEach((el) => {
      const t = el.textContent?.trim();
      if (!t) return;
      if (el.tagName === "H2") text += `\n## ${t}\n\n`;
      else if (el.tagName === "H3") text += `\n### ${t}\n\n`;
      else if (el.tagName === "LI") text += `- ${t}\n`;
      else text += `${t}\n\n`;
    });
    return `# ${d.seo_title || piece.topic}\n\n${text}`.trim();
  }
  if (piece?.content_type === "short_form") {
    const tags = Array.isArray(d.hashtags)
      ? d.hashtags.map((h: string) => (String(h).startsWith("#") ? h : `#${h}`)).join(" ")
      : "";
    return [d.post_text ?? "", tags].filter(Boolean).join("\n\n").trim();
  }
  const scenes = Array.isArray(d.scenes) ? d.scenes : [];
  const lines = scenes.map(
    (s: any) =>
      `[Scene ${s.scene_no ?? "?"} · ${s.duration_sec ?? "?"}s]\nVO: ${s.voiceover ?? ""}\nOn-screen: ${s.on_screen_text || "—"}\nVisual: ${s.visual_direction || "—"}`
  );
  return [piece?.topic ?? "", ...lines, d.video_description ? `Description:\n${d.video_description}` : ""]
    .filter(Boolean)
    .join("\n\n");
}
