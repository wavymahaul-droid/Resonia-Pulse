// Pure dashboard calculations. Runs in the browser so filters respond instantly.
import type { DashBrand, DashPost, FollowerPoint } from "@/lib/dashboard";
import { inRange, rangeDays, type DateRange } from "@/lib/range";

// Any figure based on fewer posts than this is labelled "low data".
export const LOW_DATA = 5;

// "montra" = Resonia's own pages (the id is kept from Resonia Pulse); the rest filter by platform.
export type SegmentFilter = "all" | "montra" | "linkedin" | "instagram" | "facebook" | "x";

export const SEGMENT_FILTERS: { id: SegmentFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "montra", label: "Resonia pages" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "instagram", label: "Instagram" },
  { id: "facebook", label: "Facebook" },
  { id: "x", label: "X" },
];

// Post type badges. Carousels count as Image; article link shares as Text.
export const POST_TYPES = ["Image", "Video", "Document", "Text"] as const;
export type PostType = (typeof POST_TYPES)[number];

export function postType(media: string): PostType {
  if (media === "image" || media === "carousel") return "Image";
  if (media === "video") return "Video";
  if (media === "document") return "Document";
  return "Text";
}

export function inSegment(b: DashBrand, seg: SegmentFilter): boolean {
  if (seg === "all") return true;
  if (seg === "montra") return b.is_montra;
  return b.segment === seg;
}

export type BrandStats = {
  brand: DashBrand;
  followers: number | null;
  growth: number | null; // absolute change in followers over the period
  growthPct: number | null;
  posts: number;
  postsPerWeek: number;
  avgLikes: number | null;
  avgComments: number | null;
  engagementRate: number | null; // (likes + comments) per post / followers
  engagement: number; // total likes + comments on posts in the period
  topTheme: string | null;
  themeCounts: Map<string, number>;
};

// Posts published on the range's IST days.
export function postsInRange(posts: DashPost[], range: DateRange): DashPost[] {
  return posts.filter((p) => inRange(istDay(p.posted_at), range));
}

export function brandStats(
  brands: DashBrand[],
  posts: DashPost[], // already limited to the range
  followers: FollowerPoint[], // sorted by date ascending
  range: DateRange,
): BrandStats[] {
  const startDate = range.from;
  const days = rangeDays(range);
  return brands.map((brand) => {
    const own = posts.filter((p) => p.brand === brand.id);
    // Follower counts up to the end of the range.
    const series = followers.filter((f) => f.brand === brand.id && f.date <= range.to);
    const latest = series.at(-1)?.followers ?? null;
    // Growth runs from the last snapshot on or before the range start (or the first one
    // inside it) to the last one by the range end. With a single snapshot there is nothing to compare yet.
    const base = [...series].reverse().find((f) => f.date <= startDate) ?? series[0];
    const growth = latest != null && base && series.length > 1 && base !== series.at(-1) ? latest - base.followers : null;
    const likes = own.reduce((a, p) => a + p.likes, 0);
    const comments = own.reduce((a, p) => a + p.comments, 0);
    const themeCounts = new Map<string, number>();
    for (const p of own) themeCounts.set(p.theme, (themeCounts.get(p.theme) ?? 0) + 1);
    const topTheme = [...themeCounts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const n = own.length;
    return {
      brand,
      followers: latest,
      growth,
      growthPct: growth != null && base ? growth / base.followers : null,
      posts: n,
      postsPerWeek: n / (days / 7),
      avgLikes: n ? likes / n : null,
      avgComments: n ? comments / n : null,
      engagementRate: n && latest ? (likes + comments) / n / latest : null,
      engagement: likes + comments,
      topTheme,
      themeCounts,
    };
  });
}

export function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

export type Kpis = {
  montraFollowers: number | null;
  montraGrowth: number | null;
  montraGrowthPct: number | null;
  montraPostsPerPage: number | null;
  compPostsPerPage: number | null;
  montraEr: number | null;
  compEr: number | null;
  montraSov: number | null; // share of all likes + comments in view
  montraPageCount: number;
};

export function kpis(stats: BrandStats[]): Kpis {
  const m = stats.filter((s) => s.brand.is_montra);
  const c = stats.filter((s) => !s.brand.is_montra);
  const followers = m.some((s) => s.followers != null) ? m.reduce((a, s) => a + (s.followers ?? 0), 0) : null;
  const withGrowth = m.filter((s) => s.growth != null);
  const growth = withGrowth.length ? withGrowth.reduce((a, s) => a + (s.growth ?? 0), 0) : null;
  const totalEng = stats.reduce((a, s) => a + s.engagement, 0);
  return {
    montraFollowers: followers,
    montraGrowth: growth,
    montraGrowthPct: growth != null && followers ? growth / (followers - growth) : null,
    montraPostsPerPage: m.length ? mean(m.map((s) => s.posts)) : null,
    compPostsPerPage: c.length ? mean(c.map((s) => s.posts)) : null,
    montraEr: mean(m.map((s) => s.engagementRate)),
    compEr: mean(c.map((s) => s.engagementRate)),
    montraSov: totalEng && m.length ? m.reduce((a, s) => a + s.engagement, 0) / totalEng : null,
    montraPageCount: m.length,
  };
}

// ---------- formatting (fixed to IST so server and browser render the same text) ----------

const IST = "Asia/Kolkata";

export function fmtInt(n: number | null | undefined): string {
  return n == null ? "—" : Math.round(n).toLocaleString("en-IN");
}

export function fmtCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 2)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return fmtInt(n);
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  return n == null ? "—" : `${(n * 100).toFixed(digits)}%`;
}

export function fmtSigned(n: number | null | undefined): string {
  if (n == null) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtInt(Math.abs(n))}`;
}

export function fmtDec(n: number | null | undefined, digits = 1): string {
  return n == null ? "—" : n.toFixed(digits);
}

export function fmtDate(iso: string | null | undefined, withYear = false): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  }).format(new Date(iso));
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return `${new Intl.DateTimeFormat("en-IN", {
    timeZone: IST,
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(iso))} IST`;
}

// "5 Oct 2026, 4:30 pm IST"
export function fmtPostTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short", year: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-IN", { timeZone: IST, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${date}, ${time} IST`;
}

export function istDay(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(new Date(iso));
}

// ---------- CSV ----------

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function postsCsv(
  posts: DashPost[],
  brandName: (id: string) => string,
  followers: Map<string, number>,
  isMontra: (id: string) => boolean = () => false,
): string {
  const header = [
    "date_ist",
    "brand",
    "theme",
    "post_type",
    "media_type",
    "likes",
    "comments",
    "reposts",
    "follower_engagement_rate", // (likes + comments) ÷ page followers
    "public_interactions", // reactions + comments + reposts
    "impressions",
    "clicks",
    "ctr",
    "engagements", // LinkedIn's: reactions + comments + reposts + clicks
    "linkedin_engagement_rate",
    "video", // LinkedIn counts video plays as clicks, so CTR can exceed 100%
    "post_url",
    "text",
  ];
  const rows = posts.map((p) => {
    const f = followers.get(p.brand);
    return [
      istDay(p.posted_at),
      brandName(p.brand),
      p.theme,
      postType(p.media),
      p.media,
      p.likes,
      p.comments,
      p.reposts,
      f ? ((p.likes + p.comments) / f).toFixed(6) : "",
      p.likes + p.comments + p.reposts,
      // From the uploaded LinkedIn export: Resonia only; LinkedIn does not publish competitors'.
      ...(isMontra(p.brand)
        ? [
            p.li?.impressions ?? "",
            p.li?.clicks ?? "",
            p.li?.ctr == null ? "" : p.li.ctr.toFixed(6),
            p.li?.clicks == null ? "" : (p.li.reactions ?? 0) + (p.li.comments ?? 0) + (p.li.reposts ?? 0) + p.li.clicks,
            p.li?.engagementRate == null ? "" : p.li.engagementRate.toFixed(6),
            p.li ? (p.media === "video" || p.li.video ? "yes" : "no") : "",
          ]
        : ["not public", "not public", "not public", "not public", "not public", ""]),
      p.url,
      p.text,
    ];
  });
  // BOM so Excel opens UTF-8 (₹, emoji, Hindi) correctly.
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}
