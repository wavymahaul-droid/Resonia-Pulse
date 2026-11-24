// Top posts page (/top): the best Resonia and competitor LinkedIn posts in a date range, and
// @MontraElectric's best X posts. Pure functions over data already stored, so the browser
// re-ranks instantly. No Apify calls.
import type { DashBrand, DashPost, DashXPost, FollowerPoint } from "@/lib/dashboard";
import { fmtDate, fmtInt, fmtPct, inSegment, istDay, postsInRange, type SegmentFilter } from "@/lib/metrics";
import { inRange, type DateRange } from "@/lib/range";
import { VIDEO_CTR_NOTE, engagementsOf, isVideo, publicInteractions } from "@/lib/reach";

export type TopRank = "engagement" | "rate";
export const TOP_RANKS: { id: TopRank; label: string }[] = [
  { id: "engagement", label: "Likes + comments" },
  { id: "rate", label: "Engagement rate" },
];
// The Resonia-only filter makes no sense here: Resonia and competitors are always side by side.
export const TOP_SEGMENTS: SegmentFilter[] = ["all", "linkedin", "instagram", "facebook", "x"];
export const TOP_N = 5;

export type TopPost = {
  post: DashPost;
  brand: DashBrand;
  followers: number | null; // page followers at the end of the range
  rate: number | null; // (likes + comments) ÷ followers, as on the Overview
};

// Each page's follower count on the last snapshot up to the range end.
export function followersAt(followers: FollowerPoint[], to: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const f of followers) if (f.date <= to && f.followers > 0) out.set(f.brand, f.followers); // sorted by date
  return out;
}

const plural = (v: number, one: string, many = `${one}s`) => `${fmtInt(v)} ${v === 1 ? one : many}`;
const eng = (p: DashPost) => p.likes + p.comments;
// Marks posts that are not tracked daily: known only from a LinkedIn export, or backfilled.
export const originNote = (p: Pick<DashPost, "origin">) =>
  p.origin === "export" ? " [from LinkedIn export]" : p.origin === "backfill" ? " [historical totals]" : "";

export function rankPosts(list: TopPost[], by: TopRank): TopPost[] {
  return [...list].sort(
    (a, b) =>
      (by === "rate" ? (b.rate ?? -1) - (a.rate ?? -1) : 0) ||
      eng(b.post) - eng(a.post) ||
      b.post.reposts - a.post.reposts ||
      Date.parse(b.post.posted_at) - Date.parse(a.post.posted_at),
  );
}

// Posts in the range on the segment's pages, with their engagement rate.
export function topRows(
  posts: DashPost[],
  brands: DashBrand[],
  followers: FollowerPoint[],
  range: DateRange,
  segment: SegmentFilter = "all",
): TopPost[] {
  const byId = new Map(brands.filter((b) => inSegment(b, segment)).map((b) => [b.id, b]));
  const f = followersAt(followers, range.to);
  return postsInRange(posts, range).flatMap((p) => {
    const brand = byId.get(p.brand);
    if (!brand) return [];
    const count = f.get(p.brand) ?? null;
    return [{ post: p, brand, followers: count, rate: count ? eng(p) / count : null }];
  });
}

type TopOpts = { segment?: SegmentFilter; by?: TopRank; n?: number };

export function topPosts(
  posts: DashPost[],
  brands: DashBrand[],
  followers: FollowerPoint[],
  range: DateRange,
  { segment = "all", by = "engagement", n = TOP_N }: TopOpts = {},
): { montra: TopPost[]; competitors: TopPost[] } {
  const rows = topRows(posts, brands, followers, range, segment);
  return {
    montra: rankPosts(
      rows.filter((r) => r.brand.is_montra),
      by,
    ).slice(0, n),
    competitors: rankPosts(
      rows.filter((r) => !r.brand.is_montra),
      by,
    ).slice(0, n),
  };
}

export type PageTop = { brand: DashBrand; list: TopPost[] };

// One block per page in the segment (in brands.json order), each with its own top posts.
// Pages with no posts in the range are kept, with an empty list.
export function topByPage(
  posts: DashPost[],
  brands: DashBrand[],
  followers: FollowerPoint[],
  range: DateRange,
  { segment = "all", by = "engagement", n = TOP_N }: TopOpts = {},
): { montra: PageTop[]; competitors: PageTop[] } {
  const rows = topRows(posts, brands, followers, range, segment);
  const pages = brands
    .filter((b) => inSegment(b, segment))
    .map((brand) => ({
      brand,
      list: rankPosts(
        rows.filter((r) => r.brand.id === brand.id),
        by,
      ).slice(0, n),
    }));
  return { montra: pages.filter((p) => p.brand.is_montra), competitors: pages.filter((p) => !p.brand.is_montra) };
}

// @MontraElectric's posts in the range, most viewed first.
export function topXPosts(posts: DashXPost[], range: DateRange, n = TOP_N): DashXPost[] {
  return posts
    .filter((p) => p.posted_at && inRange(istDay(p.posted_at), range))
    .sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || b.likes - a.likes)
    .slice(0, n);
}

export function fmtRate(r: number | null): string {
  return r == null ? "—" : fmtPct(r, r < 0.0001 ? 3 : 2);
}

const day = (iso: string | null) => (iso ? fmtDate(`${istDay(iso)}T12:00:00+05:30`, true) : "");
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const rankBy = (by: TopRank) =>
  `Ranked by ${by === "rate" ? "engagement rate ((likes + comments) ÷ followers)" : "likes + comments"}`;

// Resonia: impressions, CTR, engagements and LinkedIn's engagement rate from the export.
// Competitors: public interactions only (their clicks and impressions are not public).
export function reachNote(r: TopPost): string {
  const p = r.post;
  if (!r.brand.is_montra) return `, ${plural(publicInteractions(p), "public interaction")} (clicks not public)`;
  if (p.li?.impressions == null) return "";
  const eng = engagementsOf(p.li);
  return `, ${plural(p.li.impressions, "impression")}, ${p.li.ctr == null ? "—" : fmtPct(p.li.ctr, 2)} CTR, ${
    eng == null ? "—" : plural(eng, "engagement")
  }, ${p.li.engagementRate == null ? "—" : fmtPct(p.li.engagementRate, 2)} LinkedIn engagement rate (LinkedIn export${
    isVideo(p) ? `; ${VIDEO_CTR_NOTE}` : ""
  })`;
}

function postLines(lines: string[], list: TopPost[], withPage: boolean) {
  if (!list.length) lines.push("- No posts in this period");
  list.forEach((r, i) => {
    const p = r.post;
    lines.push(
      `${i + 1}. ${withPage ? `${r.brand.name} · ` : ""}${day(p.posted_at)} · ${p.theme}: "${clip(p.text || "(no text)", 120)}"${originNote(p)}`,
      `   ${plural(p.likes, "like")}, ${plural(p.comments, "comment")}, ${plural(p.reposts, "repost")}, ${fmtRate(r.rate)} follower engagement rate${reachNote(r)}`,
      `   ${p.url}`,
    );
  });
}

function xLines(lines: string[], x: DashXPost[] | null, handle: string) {
  if (!x) return;
  lines.push("", `X @${handle} (by views):`);
  if (!x.length) lines.push("- No posts in this period");
  x.forEach((p, i) => {
    lines.push(
      `${i + 1}. ${day(p.posted_at)}: "${clip(p.text, 120)}"`,
      `   ${p.views == null ? "views not reported" : plural(p.views, "view")}, ${plural(p.likes, "like")}, ${plural(p.replies, "reply", "replies")}, ${plural(p.reposts, "repost")}`,
      `   ${p.url}`,
    );
  });
}

type TextOpts = { label: string; by: TopRank; segmentLabel: string; handle: string };

// Plain text for client reports: the Overall view.
export function topText(
  t: { montra: TopPost[]; competitors: TopPost[] },
  x: DashXPost[] | null,
  { label, by, segmentLabel, handle }: TextOpts,
): string {
  const lines = [`Resonia top posts, ${label}`, `${rankBy(by)}${segmentLabel === "All" ? "" : ` · ${segmentLabel}`}`];
  lines.push("", "Resonia:");
  postLines(lines, t.montra, true);
  lines.push("", "Competitors:");
  postLines(lines, t.competitors, true);
  xLines(lines, x, handle);
  return lines.join("\n");
}

// Plain text for the By page view: posts under page-name headings. With one page picked,
// only that page (and no X section).
export function topPagesText(
  t: { montra: PageTop[]; competitors: PageTop[] },
  x: DashXPost[] | null,
  { label, by, segmentLabel, handle }: TextOpts,
): string {
  const all = [...t.montra, ...t.competitors];
  const single = all.length === 1;
  const lines = [
    single ? `${all[0].brand.name} top posts, ${label}` : `Resonia top posts by page, ${label}`,
    `${rankBy(by)}${single || segmentLabel === "All" ? "" : ` · ${segmentLabel}`}`,
  ];
  const group = (title: string, pages: PageTop[]) => {
    if (!pages.length) return;
    if (!single) lines.push("", `== ${title} ==`);
    for (const pg of pages) {
      lines.push("", `${pg.brand.name}:`);
      postLines(lines, pg.list, false);
    }
  };
  group("Resonia", t.montra);
  group("Competitors", t.competitors);
  if (!single) xLines(lines, x, handle);
  return lines.join("\n");
}

function csvCell(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV for either view. By page, the rank is within the page.
export function topCsv(
  t: { montra: TopPost[] | PageTop[]; competitors: TopPost[] | PageTop[] },
  x: DashXPost[] | null,
  handle: string,
): string {
  const header = [
    "group",
    "rank",
    "page",
    "date_ist",
    "theme",
    "likes",
    "comments",
    "reposts",
    "follower_engagement_rate", // (likes + comments) ÷ page followers
    "impressions",
    "ctr",
    "engagements",
    "linkedin_engagement_rate",
    "video", // LinkedIn counts video plays as clicks, so CTR can exceed 100%
    "public_interactions",
    "views",
    "replies",
    "url",
    "text",
  ];
  const lists = (v: TopPost[] | PageTop[]): TopPost[][] =>
    v.length && "list" in v[0] ? (v as PageTop[]).map((p) => p.list) : [v as TopPost[]];
  const li = (group: string, v: TopPost[] | PageTop[]) =>
    lists(v).flatMap((list) =>
      list.map((r, i) => [
        group,
        i + 1,
        r.brand.name,
        istDay(r.post.posted_at),
        r.post.theme,
        r.post.likes,
        r.post.comments,
        r.post.reposts,
        r.rate == null ? "" : r.rate.toFixed(6),
        // From the uploaded LinkedIn export (Resonia only; LinkedIn does not publish competitors').
        r.brand.is_montra ? (r.post.li?.impressions ?? "") : "not public",
        r.brand.is_montra ? (r.post.li?.ctr == null ? "" : r.post.li.ctr.toFixed(6)) : "not public",
        r.brand.is_montra ? (engagementsOf(r.post.li) ?? "") : "not public",
        r.brand.is_montra
          ? r.post.li?.engagementRate == null
            ? ""
            : r.post.li.engagementRate.toFixed(6)
          : "not public",
        r.brand.is_montra && r.post.li ? (isVideo(r.post) ? "yes" : "no") : "",
        publicInteractions(r.post),
        "",
        "",
        r.post.url,
        r.post.text,
      ]),
    );
  const xs = (x ?? []).map((p, i) => [
    "X",
    i + 1,
    `X @${handle}`,
    p.posted_at ? istDay(p.posted_at) : "",
    "",
    p.likes,
    "",
    p.reposts,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    p.views,
    p.replies,
    p.url,
    p.text,
  ]);
  const rows = [header, ...li("Resonia", t.montra), ...li("Competitors", t.competitors), ...xs];
  // BOM so Excel opens UTF-8 (₹, emoji, Hindi) correctly.
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
