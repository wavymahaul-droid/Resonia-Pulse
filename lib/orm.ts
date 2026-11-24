// Comment helpers shared by the dashboard and the ORM digest. Safe in the browser.
import type { DashBrand, DashComment, DashPost, DashXPost, XData } from "@/lib/dashboard";
import { istDay } from "@/lib/metrics";
import { inRange, type DateRange } from "@/lib/range";

export const SENTIMENT_ORDER = ["Negative", "Lead", "Question", "Careers", "Positive", "Neutral", "Spam"] as const;

// Job seekers and spam are kept apart from the customer conversation.
export const SEPARATE = new Set(["Careers", "Spam"]);

// Open = flagged and not yet handled.
export const isOpen = (c: DashComment) => c.needs_response && !c.handled;

// Top-level comments oldest first, each followed by its replies.
export function threaded(comments: DashComment[]): { comment: DashComment; replies: DashComment[] }[] {
  const time = (c: DashComment) => (c.posted_at ? Date.parse(c.posted_at) : 0);
  const ids = new Set(comments.map((c) => c.id));
  const roots = comments.filter((c) => !c.parent || !ids.has(c.parent)).sort((a, b) => time(a) - time(b));
  return roots.map((comment) => ({
    comment,
    replies: comments.filter((c) => c.parent === comment.id).sort((a, b) => time(a) - time(b)),
  }));
}

export function commentDay(c: DashComment): string | null {
  return c.posted_at ? istDay(c.posted_at) : null;
}

export type PageDigest = {
  brand: DashBrand;
  total: number; // new comments and replies from the public (Resonia's own replies and hidden spam excluded)
  pageReplies: number;
  spam: number;
  bySentiment: Record<string, number>;
  flagged: number;
  open: number;
};

// X activity for @MontraElectric over the digest's range. Customer mentions are also in the digest totals,
// the by-page table (as "X @MontraElectric") and the flagged list.
export type XDigest = {
  mentions: number; // new customer mentions (media mentions and our replies not counted)
  media: DashComment[]; // new media mentions
  posts: DashXPost[]; // our posts in the range
  replies: number; // our replies in the range
  followers: number | null; // latest snapshot by the end of the range
  followerChange: number | null; // against the last snapshot before the range (or the first in it)
  placeholders: DashComment[]; // our replies in the range with an unfilled template placeholder
};

export function xDigest(range: DateRange, comments: DashComment[], x: XData): XDigest | null {
  if (!x.ready) return null;
  const day = comments.filter((c) => c.channel === "x" && inRange(commentDay(c), range));
  const snaps = x.followers.filter((f) => f.date <= range.to);
  const last = snaps.at(-1);
  const before = snaps.filter((f) => f.date < range.from).at(-1) ?? snaps.find((f) => f.date >= range.from);
  const prev = before && before !== last ? before : undefined;
  return {
    mentions: day.filter((c) => !c.page_reply && !c.media).length,
    media: day.filter((c) => !c.page_reply && c.media),
    posts: x.posts.filter((p) => p.posted_at && inRange(istDay(p.posted_at), range)),
    replies: day.filter((c) => c.page_reply).length,
    followers: last?.followers ?? null,
    followerChange: last && prev ? last.followers - prev.followers : null,
    placeholders: day.filter((c) => c.x?.placeholder),
  };
}

export type Digest = {
  range: DateRange;
  pages: PageDigest[];
  total: number;
  bySentiment: Record<string, number>;
  flagged: DashComment[];
  careers: DashComment[];
  spam: number; // spam comments that day, counted in the totals only with includeSpam
  includeSpam: boolean;
  topPost: { post: DashPost | undefined; url: string; count: number } | null;
  x: XDigest | null;
  liMentions: DashComment[]; // LinkedIn mentions posted that day (flagged ones are also in `flagged`)
};

// A digest of everything posted in the range (IST days, both included). A single day can be
// passed as "YYYY-MM-DD".
export function digest(
  when: DateRange | string,
  comments: DashComment[],
  posts: DashPost[],
  brands: DashBrand[],
  { includeSpam = false, x = null }: { includeSpam?: boolean; x?: XData | null } = {},
): Digest {
  const range: DateRange = typeof when === "string" ? { key: "custom", from: when, to: when } : when;
  const dayAll = comments.filter((c) => inRange(commentDay(c), range));
  // LinkedIn mentions get their own section; the flagged ones also join the flagged list.
  const liMentions = dayAll.filter((c) => c.channel === "li_mention");
  const day = dayAll.filter((c) => c.channel !== "li_mention");
  // X media mentions are listed in the X section, not counted as customer comments,
  // unless they are negative (then they are flagged).
  const all = day.filter((c) => !c.page_reply && (!c.media || c.needs_response));
  const isSpam = (c: DashComment) => c.sentiment === "Spam";
  const pub = includeSpam ? all : all.filter((c) => !isSpam(c));
  const split = (list: DashComment[]) =>
    Object.fromEntries(SENTIMENT_ORDER.map((s) => [s, list.filter((c) => c.sentiment === s).length]));
  const pages = brands.map((b) => {
    const mine = pub.filter((c) => c.brand === b.id);
    return {
      brand: b,
      total: mine.length,
      pageReplies: day.filter((c) => c.brand === b.id && c.page_reply).length,
      spam: all.filter((c) => c.brand === b.id && isSpam(c)).length,
      bySentiment: split(mine),
      flagged: mine.filter((c) => c.needs_response).length,
      open: mine.filter(isOpen).length,
    };
  });
  const perPost = new Map<string, number>();
  // Spam never makes a post the most discussed one, and X threads are not LinkedIn posts.
  for (const c of all.filter((c) => !isSpam(c) && c.channel !== "x"))
    perPost.set(c.post_url, (perPost.get(c.post_url) ?? 0) + 1);
  const top = [...perPost].sort((a, b) => b[1] - a[1])[0];
  return {
    range,
    pages,
    total: pub.length,
    bySentiment: split(pub),
    flagged: [...pub, ...liMentions]
      .filter((c) => c.needs_response)
      .sort((a, b) => SENTIMENT_ORDER.indexOf(a.sentiment as never) - SENTIMENT_ORDER.indexOf(b.sentiment as never)),
    careers: pub.filter((c) => c.sentiment === "Careers"),
    spam: all.filter(isSpam).length,
    includeSpam,
    topPost: top ? { post: posts.find((p) => p.url === top[0]), url: top[0], count: top[1] } : null,
    x: x ? xDigest(range, comments, x) : null,
    liMentions,
  };
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

export function digestText(d: Digest, dateLabel: string, brandName: (id: string) => string): string {
  const lines = [`Resonia ORM digest, ${dateLabel}`, ""];
  const shown = SENTIMENT_ORDER.filter((s) => s !== "Spam" || d.includeSpam);
  lines.push(`New comments: ${d.total}${!d.includeSpam && d.spam ? ` (plus ${d.spam} spam, hidden)` : ""}`);
  lines.push(`Sentiment: ${shown.map((s) => `${s} ${d.bySentiment[s]}`).join(", ")}`);
  lines.push("");
  lines.push("By page:");
  for (const p of d.pages) {
    lines.push(
      `- ${p.brand.name}: ${p.total} new${
        p.total
          ? ` (${shown
              .filter((s) => p.bySentiment[s])
              .map((s) => `${s} ${p.bySentiment[s]}`)
              .join(", ")})`
          : ""
      }, ${p.flagged} need response, ${p.open} still open${p.pageReplies ? `, ${p.pageReplies} Resonia replies` : ""}`,
    );
  }
  lines.push("");
  lines.push(`Needs response (${d.flagged.length}):`);
  if (!d.flagged.length) lines.push("- None");
  for (const c of d.flagged) {
    lines.push(
      `- [${c.channel === "x" ? "X · " : c.channel === "li_mention" ? "LinkedIn mention · " : ""}${c.sentiment}${c.media ? ", media mention" : ""}${c.handled ? ", handled" : ""}] ${brandName(c.brand)} · ${c.name}: "${clip(c.text, 200)}"`,
    );
    const link = c.url ?? (c.channel ? null : c.post_url);
    if (link) lines.push(`  ${link}`);
  }
  if (d.careers.length) {
    lines.push("");
    lines.push(`Job seekers (${d.careers.length}, no response needed):`);
    for (const c of d.careers) lines.push(`- ${brandName(c.brand)} · ${c.name}: "${clip(c.text, 120)}"`);
  }
  lines.push("");
  if (d.topPost) {
    lines.push(`Most discussed post (${d.topPost.count} new comments): ${clip(d.topPost.post?.text ?? "", 120)}`);
    lines.push(`  ${d.topPost.url}`);
  } else {
    lines.push("Most discussed post: none (no new comments)");
  }
  lines.push("");
  lines.push(`LinkedIn mentions (${d.liMentions.length}):`);
  if (!d.liMentions.length) lines.push("- None");
  for (const c of d.liMentions) {
    const label = c.li?.staff ? "Resonia team" : c.media ? "Media mention" : c.sentiment;
    lines.push(`- [${label}] ${c.name}: "${clip(c.text, 160)}"`);
    if (c.url) lines.push(`  ${c.url}`);
  }
  if (d.x) {
    const x = d.x;
    lines.push("");
    lines.push("X (@MontraElectric):");
    lines.push(
      `- Followers: ${x.followers ?? "not recorded yet"}${x.followerChange != null ? ` (${x.followerChange >= 0 ? "+" : ""}${x.followerChange})` : ""}`,
    );
    lines.push(
      `- New mentions: ${x.mentions} from customers, ${x.media.length} media mentions, ${x.replies} Resonia replies`,
    );
    for (const c of x.media) lines.push(`  · Media mention · ${c.name}: "${clip(c.text, 120)}"`);
    lines.push(`- Our posts: ${x.posts.length}`);
    for (const p of x.posts) {
      lines.push(`  · "${clip(p.text, 100)}" (${p.likes} likes, ${p.replies} replies, ${p.reposts} reposts)`);
      lines.push(`    ${p.url}`);
    }
    if (x.placeholders.length) {
      lines.push(`- Our replies with an unfilled template placeholder: ${x.placeholders.length}`);
      for (const c of x.placeholders) lines.push(`  · "${clip(c.text, 120)}"${c.url ? ` ${c.url}` : ""}`);
    }
  }
  return lines.join("\n");
}

function csvCell(v: string | number | boolean | null): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function commentsCsv(comments: DashComment[], brandName: (id: string) => string): string {
  const header = [
    "date_ist",
    "posted_at",
    "channel",
    "page",
    "commenter",
    "headline",
    "sentiment",
    "media_mention",
    "needs_response",
    "handled",
    "handled_by",
    "is_reply",
    "montra_reply",
    "reactions",
    "text",
    "comment_url",
    "post_url",
  ];
  const rows = comments.map((c) => [
    commentDay(c),
    c.posted_at,
    c.channel === "x" ? "X" : c.channel === "li_mention" ? "LinkedIn mention" : "LinkedIn",
    brandName(c.brand),
    c.name,
    c.headline,
    c.sentiment,
    !!c.media,
    c.needs_response,
    c.handled,
    c.handled_by,
    !!c.parent,
    c.page_reply,
    c.reactions,
    c.text,
    c.url,
    c.channel ? "" : c.post_url,
  ]);
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

export function download(name: string, body: string, type = "text/csv;charset=utf-8") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
