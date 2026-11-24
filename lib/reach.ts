// Impressions, clicks, CTR and engagements from uploaded LinkedIn analytics exports (Resonia pages
// only; LinkedIn does not publish them for other companies' pages). Safe in the browser.
//
// Rates are always ratios of sums over the period (total clicks ÷ total impressions), never an
// average of daily or per-post percentages. Every post on a Resonia feed is organic: paid campaigns run
// as dark posts that never appear on the feed (they are listed apart as "Ad (not on feed)"). The
// Organic / Sponsored / All switch is for the page's daily totals, from the export's own columns.
import type { DashBrand, DashPost, LiExportData, LiPageDay, LiPostMetrics } from "@/lib/dashboard";
import { LOW_DATA, fmtDate, fmtInt, fmtPct, istDay } from "@/lib/metrics";
import { inRange, shiftDay, type DateRange } from "@/lib/range";

export const NOT_PUBLIC = "not public";
export const PUBLIC_INTERACTIONS = "Public interactions (reactions + comments + reposts)";
export const CLICKS_NOT_PUBLIC =
  "Clicks aren't public for other companies' pages, so this is not LinkedIn's engagement count.";
export const PAGE_IMPRESSIONS = "Page impressions (all posts, daily totals)";
export const POST_IMPRESSIONS = "Impressions on posts published in this period";

// Page daily totals only.
export type ReachMode = "organic" | "sponsored" | "all";
export const REACH_MODES: { id: ReachMode; label: string }[] = [
  { id: "organic", label: "Organic" },
  { id: "sponsored", label: "Sponsored" },
  { id: "all", label: "All (organic + sponsored)" },
];

// "from LinkedIn export, last uploaded 6 Oct 2026"
export function liLabel(li: Pick<LiExportData, "lastUploaded">): string {
  return li.lastUploaded
    ? `from LinkedIn export, last uploaded ${fmtDate(li.lastUploaded, true)}`
    : "from LinkedIn export, nothing uploaded yet";
}

export const fmtCtr = (ctr: number | null | undefined) => (ctr == null ? "—" : fmtPct(ctr, 2));
export const fmtImpressions = (n: number | null | undefined) => (n == null ? "—" : fmtInt(n));

// LinkedIn's engagements for a post: reactions + comments + reposts + clicks.
export function engagementsOf(li: LiPostMetrics | undefined): number | null {
  if (!li || li.clicks == null) return null;
  return (li.reactions ?? 0) + (li.comments ?? 0) + (li.reposts ?? 0) + li.clicks;
}

// Reactions + comments + reposts anyone can see (competitors; no clicks).
export const publicInteractions = (p: Pick<DashPost, "likes" | "comments" | "reposts">) =>
  p.likes + p.comments + p.reposts;

export const VIDEO_CTR_NOTE = "Video: LinkedIn counts plays as clicks, so CTR can exceed 100%";

// A video post: the tracker's media type, or the export's Content Type.
export const isVideo = (p: Pick<DashPost, "media" | "li">) => p.media === "video" || !!p.li?.video;

export type Reach = {
  posts: number; // posts in the range with export numbers
  impressions: number;
  clicks: number;
  engagements: number;
  ctr: number | null; // total clicks ÷ total impressions
  videos: number; // of those, video posts
  ctrExVideo: number | null; // the same without video posts (their plays count as clicks)
  er: number | null; // total engagements ÷ total impressions (LinkedIn's engagement rate)
  avgImpressions: number | null;
  low: boolean;
};

export function reachOf(posts: DashPost[]): Reach {
  const withLi = posts.filter((p) => !p.ad && p.li?.impressions != null);
  const sum = (f: (li: LiPostMetrics) => number | null, list = withLi) => list.reduce((a, p) => a + (f(p.li!) ?? 0), 0);
  const impressions = sum((li) => li.impressions);
  const clicks = sum((li) => li.clicks);
  const noVideo = withLi.filter((p) => !isVideo(p));
  const impressionsExVideo = sum((li) => li.impressions, noVideo);
  const engagements = sum((li) => engagementsOf(li));
  return {
    posts: withLi.length,
    impressions,
    clicks,
    engagements,
    ctr: impressions ? clicks / impressions : null,
    videos: withLi.length - noVideo.length,
    ctrExVideo: impressionsExVideo ? sum((li) => li.clicks, noVideo) / impressionsExVideo : null,
    er: impressions ? engagements / impressions : null,
    avgImpressions: withLi.length ? impressions / withLi.length : null,
    low: withLi.length < LOW_DATA,
  };
}

// Resonia feed posts published in the range: overall and per page.
export function postReach(
  posts: DashPost[],
  brands: DashBrand[],
  range: DateRange,
): { all: Reach; pages: { brand: DashBrand; reach: Reach; posts: number }[] } {
  const montra = brands.filter((b) => b.is_montra);
  const inR = posts.filter((p) => inRange(istDay(p.posted_at), range));
  return {
    all: reachOf(inR.filter((p) => montra.some((b) => b.id === p.brand))),
    pages: montra.map((brand) => {
      const own = inR.filter((p) => p.brand === brand.id);
      return { brand, reach: reachOf(own), posts: own.length };
    }),
  };
}

export type PageTotals = {
  days: number; // days in the range with uploaded Content numbers
  impressions: number | null;
  clicks: number | null;
  engagements: number | null;
  ctr: number | null;
  er: number | null;
  newFollowers: number | null;
  pageViews: number | null;
  uniqueVisitors: number | null; // summed daily uniques (LinkedIn's own period total may be lower)
  // Organic or sponsored was asked for but the uploads have no organic / sponsored split yet
  // (uploaded before that was kept): the counts are LinkedIn's totals instead.
  noSplit: boolean;
};

type Counted = "impressions" | "clicks" | "reactions" | "comments" | "reposts";
const field = (k: Counted, mode: ReachMode): keyof LiPageDay =>
  mode === "all" ? k : (`${k}_${mode}` as keyof LiPageDay);

// Daily page numbers summed over the range, for the given pages (null when none were uploaded).
export function pageTotals(
  li: LiExportData,
  range: DateRange,
  brandIds?: string[],
  mode: ReachMode = "organic",
): PageTotals {
  const rows = li.pages.filter((d) => inRange(d.date, range) && (!brandIds || brandIds.includes(d.brand)));
  const content = rows.filter((r) => r.impressions != null);
  const noSplit = mode !== "all" && content.length > 0 && content.every((r) => r.impressions_organic == null);
  const use: ReachMode = noSplit ? "all" : mode;
  const sumOf = (list: LiPageDay[], k: keyof LiPageDay) => {
    const vals = list.map((r) => r[k]).filter((v): v is number => typeof v === "number");
    return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  };
  const sum = (k: Counted) => sumOf(content, field(k, use));
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const parts = (["reactions", "comments", "reposts"] as const).map(sum);
  const engagements = clicks == null ? null : clicks + parts.reduce<number>((a, v) => a + (v ?? 0), 0);
  return {
    days: new Set(content.map((r) => r.date)).size,
    impressions,
    clicks,
    engagements,
    ctr: impressions && clicks != null ? clicks / impressions : null,
    er: impressions && engagements != null ? engagements / impressions : null,
    newFollowers: sumOf(rows, "new_followers"),
    pageViews: sumOf(rows, "page_views"),
    uniqueVisitors: sumOf(rows, "unique_visitors"),
    noSplit,
  };
}

// ---------- coverage: which days each export covers ----------

export type ExportKind = "content" | "followers" | "visitors";
export const KIND_LABEL: Record<ExportKind, string> = {
  content: "Content",
  followers: "Followers",
  visitors: "Visitors",
};
const has: Record<ExportKind, (r: LiPageDay) => boolean> = {
  content: (r) => r.impressions != null,
  followers: (r) => r.new_followers != null,
  visitors: (r) => r.page_views != null || r.unique_visitors != null,
};

export function daysOf(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = shiftDay(d, 1)) out.push(d);
  return out;
}

// For each page and export, the days in the range with no uploaded numbers.
export function missingDays(
  li: LiExportData,
  range: DateRange,
  brands: DashBrand[],
): { brand: DashBrand; missing: Record<ExportKind, string[]> }[] {
  const all = daysOf(range);
  return brands.map((brand) => {
    const rows = li.pages.filter((r) => r.brand === brand.id && inRange(r.date, range));
    const missing = Object.fromEntries(
      (Object.keys(has) as ExportKind[]).map((k) => {
        const got = new Set(rows.filter(has[k]).map((r) => r.date));
        return [k, all.filter((d) => !got.has(d))];
      }),
    ) as Record<ExportKind, string[]>;
    return { brand, missing };
  });
}

// "1–7 Oct, 12 Oct" from a sorted list of YYYY-MM-DD days.
export function fmtDays(days: string[]): string {
  const short = (d: string) => fmtDate(`${d}T12:00:00+05:30`);
  const runs: [string, string][] = [];
  for (const d of days) {
    const last = runs.at(-1);
    if (last && shiftDay(last[1], 1) === d) last[1] = d;
    else runs.push([d, d]);
  }
  return runs
    .map(([a, b]) => {
      if (a === b) return short(a);
      const [da, db] = [short(a), short(b)];
      const [ma, mb] = [da.split(" ")[1], db.split(" ")[1]];
      return ma === mb ? `${da.split(" ")[0]}–${db}` : `${da} – ${db}`;
    })
    .join(", ");
}
