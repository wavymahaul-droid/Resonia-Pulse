// Client report (/report): one summary for any date range, with the change against the
// previous period of equal length. Built from data already stored; no Apify calls.
import {
  earnedOwned,
  fmtHours,
  mediaOutlets,
  previousRange,
  responseTimes,
  type Outlet,
  type ResponseStats,
} from "@/lib/analytics";
import type { DashComment, DashboardData } from "@/lib/dashboard";
import {
  bestSlots,
  fmtSlot,
  highlights,
  LOW_DATA,
  timeGrid,
  type Highlight,
  type Slot,
} from "@/lib/insights";
import {
  brandStats,
  fmtDate,
  fmtInt,
  fmtPct,
  istDay,
  kpis,
  postsInRange,
} from "@/lib/metrics";
import { SENTIMENT_ORDER, digest } from "@/lib/orm";
import { fmtRange, type DateRange } from "@/lib/range";
import {
  fmtRate,
  originNote,
  reachNote,
  topPosts,
  topRows,
  type TopPost,
} from "@/lib/top";
import {
  PAGE_IMPRESSIONS,
  POST_IMPRESSIONS,
  PUBLIC_INTERACTIONS,
  VIDEO_CTR_NOTE,
  liLabel,
  pageTotals,
  postReach,
  publicInteractions,
} from "@/lib/reach";
import { X_BRAND } from "@/lib/x";
import {
  newFollowers,
  withExportFollowers,
  type FollowerSplit,
} from "@/lib/followers";
import {
  LI_EXPORTS_ENABLED,
  ORM_ENABLED,
  POSTS_BACKFILLED_FROM,
} from "@/lib/brands";
import { rangeDays } from "@/lib/range";

export type Format = "int" | "dec" | "pct" | "hours";
export type Metric = {
  label: string;
  now: number | null;
  prev: number | null;
  format: Format;
  low?: boolean; // the current figure rests on fewer than 5 posts or replies
  lowerIsBetter?: boolean;
  // The previous period has little or no tracked data (before tracking or the backfill began), so
  // no change, previous figure or trend is shown.
  noPrev?: boolean;
  note?: string; // where a fallback figure came from
};

export const NO_PREV = "no comparable earlier data";

// The first IST day each kind of figure has complete data from.
export type Coverage = {
  posts: string; // daily tracking, or the post backfill if earlier
  followers: string | null; // the last page to get its first follower count
  orm: string | null; // comments, LinkedIn mentions and X mentions: daily tracking
  x: string | null; // first @MontraElectric follower count
};

export function coverage(data: DashboardData): Coverage {
  const tracking = data.trackingSince ? data.trackingSince.slice(0, 10) : null;
  const first = new Map<string, string>();
  for (const f of data.followers) {
    if (
      f.followers > 0 &&
      (!first.has(f.brand) || f.date < first.get(f.brand)!)
    )
      first.set(f.brand, f.date);
  }
  const starts = [...first.values()].sort();
  const xStart = data.x.followers
    .filter((f) => f.followers > 0)
    .map((f) => f.date)
    .sort()[0];
  return {
    posts:
      tracking && tracking < POSTS_BACKFILLED_FROM
        ? tracking
        : POSTS_BACKFILLED_FROM,
    followers: starts.at(-1) ?? null,
    orm: tracking,
    x: xStart ?? tracking,
  };
}

// A share of the previous period's days with data below this counts as little data.
const MIN_COVERED = 0.9;

export type Report = {
  range: DateRange;
  prev: DateRange;
  label: string;
  prevLabel: string;
  kpis: Metric[];
  highlights: Highlight[];
  top: { montra: TopPost[]; competitors: TopPost[] };
  orm: {
    metrics: Metric[];
    sentiment: { name: string; now: number; prev: number | null }[]; // prev null: not comparable
    flagged: DashComment[];
    response: ResponseStats;
  };
  x: { ready: boolean; handle: string; metrics: Metric[] };
  earned: { metrics: Metric[]; outlets: Outlet[] };
  // Resonia impressions, clicks and CTR from uploaded LinkedIn exports; competitors' are not public.
  reach: { ready: boolean; label: string; mode: string; metrics: Metric[] };
  bestTime: Slot[];
  anyPrev: boolean; // some figure has comparable earlier data
  // New followers per Resonia page from the uploaded Followers exports (LinkedIn's own figures).
  newFollowers: ({ page: string } & FollowerSplit)[];
};

export function buildReport(data: DashboardData, range: DateRange): Report {
  const prev = previousRange(range);
  const now = data.generatedAt;
  // Comparisons only where the previous period is fully covered by that kind of data.
  const cov = coverage(data);
  const covered = (since: string | null) => !!since && since <= prev.from;
  const noPosts = !covered(cov.posts);
  const noFollowers = !covered(cov.followers);
  // Engagement rates need complete posts and a follower count by the end of the period.
  const noRate = noPosts || !cov.followers || cov.followers > prev.to;
  const noOrm = !covered(cov.orm);
  const noX = !covered(cov.x);

  // KPIs: Resonia vs competitors.
  const side = (r: DateRange) => {
    const posts = postsInRange(data.posts, r);
    const stats = brandStats(data.brands, posts, data.followers, r);
    // Follower KPIs fall back to the uploaded Followers exports when the scraped counts have none.
    const k = withExportFollowers(kpis(stats), {
      days: data.liExport.pages,
      followers: data.followers,
      range: r,
      montraIds: data.brands.filter((x) => x.is_montra).map((x) => x.id),
    });
    const m = stats.filter((s) => s.brand.is_montra);
    const c = stats.filter((s) => !s.brand.is_montra);
    return {
      k,
      montraPosts: m.reduce((a, s) => a + s.posts, 0),
      compPosts: c.reduce((a, s) => a + s.posts, 0),
      montraEng: m.reduce((a, s) => a + s.engagement, 0),
      // Reactions + comments + reposts anyone can see; LinkedIn's engagements add clicks, which
      // are not public for competitors.
      montraPublic: posts
        .filter((p) => m.some((s) => s.brand.id === p.brand))
        .reduce((a, p) => a + publicInteractions(p), 0),
      compPublic: posts
        .filter((p) => c.some((s) => s.brand.id === p.brand))
        .reduce((a, p) => a + publicInteractions(p), 0),
      compEngPerPage: c.length
        ? c.reduce((a, s) => a + s.engagement, 0) / c.length
        : null,
    };
  };
  const montraPages = data.brands.filter((x) => x.is_montra);
  const fullExport = (r: DateRange) =>
    montraPages.every((p) => {
      const f = newFollowers(data.liExport.pages, p.id, r);
      return f.total != null && f.days === f.of;
    });
  const a = side(range);
  const b = side(prev);
  const kpiList: Metric[] = [
    {
      label: "Resonia followers (all pages)",
      now: a.k.montraFollowers,
      prev: b.k.montraFollowers,
      format: "int",
      noPrev: noFollowers,
      note: a.k.followersNote,
    },
    {
      label: "Resonia follower growth",
      now: a.k.montraGrowth,
      prev: b.k.montraGrowth,
      format: "int",
      // Comparable from the scraped counts, or when the exports cover both periods in full.
      noPrev: noFollowers && !(fullExport(range) && fullExport(prev)),
      note: a.k.growthNote,
    },
    {
      label: "Resonia posts",
      now: a.montraPosts,
      prev: b.montraPosts,
      format: "int",
      noPrev: noPosts,
    },
    {
      label: "Posts per page: Resonia",
      now: a.k.montraPostsPerPage,
      prev: b.k.montraPostsPerPage,
      format: "dec",
      noPrev: noPosts,
    },
    {
      label: "Posts per page: competitors",
      now: a.k.compPostsPerPage,
      prev: b.k.compPostsPerPage,
      format: "dec",
      noPrev: noPosts,
    },
    {
      label:
        "Follower engagement rate: Resonia ((likes + comments) ÷ followers)",
      now: a.k.montraEr,
      prev: b.k.montraEr,
      format: "pct",
      low: a.montraPosts < LOW_DATA,
      noPrev: noRate,
    },
    {
      label: "Follower engagement rate: competitors",
      now: a.k.compEr,
      prev: b.k.compEr,
      format: "pct",
      low: a.compPosts < LOW_DATA,
      noPrev: noRate,
    },
    {
      label: "Resonia likes + comments",
      now: a.montraEng,
      prev: b.montraEng,
      format: "int",
      noPrev: noPosts,
    },
    {
      label: `${PUBLIC_INTERACTIONS}: Resonia`,
      now: a.montraPublic,
      prev: b.montraPublic,
      format: "int",
      noPrev: noPosts,
    },
    {
      label: `${PUBLIC_INTERACTIONS}: competitors`,
      now: a.compPublic,
      prev: b.compPublic,
      format: "int",
      noPrev: noPosts,
    },
    {
      label: "Resonia share of voice",
      now: a.k.montraSov,
      prev: b.k.montraSov,
      format: "pct",
      noPrev: noPosts,
    },
  ];

  // ORM: the digest of the range and of the previous period.
  const commentBrands = [
    ...data.brands.filter((x) => x.track_comments),
    ...(data.x.ready ? [X_BRAND] : []),
  ];
  const d = digest(range, data.comments, data.posts, commentBrands, {
    x: data.x,
  });
  const dp = digest(prev, data.comments, data.posts, commentBrands, {
    x: data.x,
  });
  const rt = responseTimes(data.comments, range, now);
  const rtPrev = responseTimes(data.comments, prev, now);
  const ormMetrics: Metric[] = [
    {
      label: "New comments and X mentions",
      now: d.total,
      prev: dp.total,
      format: "int",
    },
    {
      label: "Needing a response",
      now: d.flagged.length,
      prev: dp.flagged.length,
      format: "int",
      lowerIsBetter: true,
    },
    {
      label: "Still open",
      now: d.flagged.filter((c) => !c.handled).length,
      prev: dp.flagged.filter((c) => !c.handled).length,
      format: "int",
      lowerIsBetter: true,
    },
    {
      label: "Average response time",
      now: rt.avgHours,
      prev: rtPrev.avgHours,
      format: "hours",
      low: rt.low,
      lowerIsBetter: true,
    },
    {
      label: "Median response time",
      now: rt.medianHours,
      prev: rtPrev.medianHours,
      format: "hours",
      low: rt.low,
      lowerIsBetter: true,
    },
    {
      label: "Unanswered after 24 hours",
      now: rt.over24,
      prev: rtPrev.over24,
      format: "int",
      lowerIsBetter: true,
    },
    {
      label: "Unanswered after 48 hours",
      now: rt.over48,
      prev: rtPrev.over48,
      format: "int",
      lowerIsBetter: true,
    },
  ];

  for (const m of ormMetrics) m.noPrev = noOrm;

  // X.
  const xm = (dd: typeof d) => dd.x;
  const xMetrics: Metric[] = data.x.ready
    ? [
        {
          label: "Followers",
          now: xm(d)?.followers ?? null,
          prev: xm(dp)?.followers ?? null,
          format: "int",
        },
        {
          label: "Follower change",
          now: xm(d)?.followerChange ?? null,
          prev: xm(dp)?.followerChange ?? null,
          format: "int",
        },
        {
          label: "Customer mentions",
          now: xm(d)?.mentions ?? 0,
          prev: xm(dp)?.mentions ?? 0,
          format: "int",
        },
        {
          label: "Media mentions",
          now: xm(d)?.media.length ?? 0,
          prev: xm(dp)?.media.length ?? 0,
          format: "int",
        },
        {
          label: "Resonia replies",
          now: xm(d)?.replies ?? 0,
          prev: xm(dp)?.replies ?? 0,
          format: "int",
        },
        {
          label: "Resonia posts",
          now: xm(d)?.posts.length ?? 0,
          prev: xm(dp)?.posts.length ?? 0,
          format: "int",
        },
      ]
    : [];
  for (const m of xMetrics) m.noPrev = noX;

  // Earned vs owned.
  const e = earnedOwned(
    data.comments,
    data.posts,
    data.x.posts,
    data.brands,
    range,
  );
  const ep = earnedOwned(
    data.comments,
    data.posts,
    data.x.posts,
    data.brands,
    prev,
  );
  const earnedMetrics: Metric[] = [
    {
      label: "LinkedIn media mentions",
      now: e.total.liMedia,
      prev: ep.total.liMedia,
      format: "int",
      noPrev: noOrm,
    },
    {
      label: "X media mentions",
      now: e.total.xMedia,
      prev: ep.total.xMedia,
      format: "int",
      noPrev: noX,
    },
    {
      label: "Resonia LinkedIn posts",
      now: e.total.liPosts,
      prev: ep.total.liPosts,
      format: "int",
      noPrev: noPosts,
    },
    {
      label: "Resonia X posts",
      now: e.total.xPosts,
      prev: ep.total.xPosts,
      format: "int",
      noPrev: noX,
    },
  ];

  // Reach from uploaded LinkedIn exports (Resonia pages only).
  const montraIds = data.brands.filter((x) => x.is_montra).map((x) => x.id);
  // Page daily totals: the export's organic columns (dark-post campaigns are in the sponsored ones).
  const pt = pageTotals(data.liExport, range, montraIds, "organic");
  const ptPrev = pageTotals(data.liExport, prev, montraIds, "organic");
  // Posts: every post on a Resonia feed is organic.
  const pr = postReach(data.posts, data.brands, range).all;
  const prPrev = postReach(data.posts, data.brands, prev).all;
  const lowPosts = pr.posts > 0 && pr.low;
  // Page totals: the export must have most of the previous period's days. Post figures: most of
  // the previous period's Resonia posts must have export numbers.
  const noPages = ptPrev.days < MIN_COVERED * rangeDays(prev);
  const prevPosts = postReach(data.posts, data.brands, prev);
  const prevMontraPosts = prevPosts.pages.reduce((s, p) => s + p.posts, 0);
  const noPostReach =
    noPosts ||
    !prevMontraPosts ||
    prevPosts.all.posts < MIN_COVERED * prevMontraPosts;
  const reachMetrics: Metric[] = [
    {
      label: `${PAGE_IMPRESSIONS}`,
      now: pt.impressions,
      prev: ptPrev.impressions,
      format: "int",
    },
    {
      label: "Clicks (daily totals)",
      now: pt.clicks,
      prev: ptPrev.clicks,
      format: "int",
    },
    {
      label: "CTR (total clicks ÷ total impressions)",
      now: pt.ctr,
      prev: ptPrev.ctr,
      format: "pct",
    },
    {
      label: "Engagements (reactions + comments + reposts + clicks)",
      now: pt.engagements,
      prev: ptPrev.engagements,
      format: "int",
    },
    {
      label: "Engagement rate (LinkedIn: engagements ÷ impressions)",
      now: pt.er,
      prev: ptPrev.er,
      format: "pct",
    },
    {
      label: "Page views",
      now: pt.pageViews,
      prev: ptPrev.pageViews,
      format: "int",
    },
    {
      label: "Unique visitors (sum of daily)",
      now: pt.uniqueVisitors,
      prev: ptPrev.uniqueVisitors,
      format: "int",
    },
    {
      label: "New followers",
      now: pt.newFollowers,
      prev: ptPrev.newFollowers,
      format: "int",
    },
    {
      label: POST_IMPRESSIONS,
      now: pr.posts ? pr.impressions : null,
      prev: prPrev.posts ? prPrev.impressions : null,
      format: "int",
      low: lowPosts,
    },
    {
      label: "Impressions per post",
      now: pr.avgImpressions,
      prev: prPrev.avgImpressions,
      format: "int",
      low: lowPosts,
    },
    {
      label: "CTR on those posts (with video)",
      now: pr.ctr,
      prev: prPrev.ctr,
      format: "pct",
      low: lowPosts,
    },
    {
      label: "CTR on those posts, without video posts",
      now: pr.ctrExVideo,
      prev: prPrev.ctrExVideo,
      format: "pct",
      low: pr.posts - pr.videos > 0 && pr.posts - pr.videos < LOW_DATA,
    },
    {
      label: "Engagements on those posts",
      now: pr.posts ? pr.engagements : null,
      prev: prPrev.posts ? prPrev.engagements : null,
      format: "int",
      low: lowPosts,
    },
    {
      label: "Engagement rate on those posts",
      now: pr.er,
      prev: prPrev.er,
      format: "pct",
      low: lowPosts,
    },
  ];
  // The first 8 are page totals, the rest per-post figures.
  reachMetrics.forEach((m, i) => (m.noPrev = i < 8 ? noPages : noPostReach));

  const rows = topRows(data.posts, data.brands, data.followers, range);
  return {
    range,
    prev,
    label: fmtRange(range),
    prevLabel: fmtRange(prev),
    kpis: kpiList,
    highlights: highlights({
      posts: data.posts,
      brands: data.brands,
      followers: data.followers,
      range,
      segment: "all",
      trackingSince: data.trackingSince,
    }),
    top: topPosts(data.posts, data.brands, data.followers, range, { n: 3 }),
    orm: {
      metrics: ormMetrics,
      sentiment: SENTIMENT_ORDER.filter((s) => s !== "Spam").map((s) => ({
        name: s,
        now: d.bySentiment[s] ?? 0,
        prev: noOrm ? null : (dp.bySentiment[s] ?? 0),
      })),
      flagged: d.flagged,
      response: rt,
    },
    x: { ready: data.x.ready, handle: data.x.handle, metrics: xMetrics },
    earned: {
      metrics: earnedMetrics,
      outlets: mediaOutlets(data.comments, range),
    },
    reach: {
      ready: data.liExport.ready,
      label: liLabel(data.liExport),
      // Uploads saved before organic and sponsored were kept apart only have LinkedIn's totals.
      mode: pt.noSplit ? "All (organic + sponsored)" : "Organic",
      metrics: reachMetrics,
    },
    bestTime: bestSlots(timeGrid(rows.filter((r) => r.brand.is_montra))),
    newFollowers: montraPages.map((p) => ({
      page: p.name,
      ...newFollowers(data.liExport.pages, p.id, range),
    })),
    anyPrev: [
      ...kpiList,
      ...ormMetrics,
      ...xMetrics,
      ...earnedMetrics,
      ...reachMetrics,
    ].some((m) => !m.noPrev),
  };
}

// ---------- formatting ----------

export function fmtValue(v: number | null, f: Format): string {
  if (v == null) return "—";
  if (f === "pct") return fmtPct(v, Math.abs(v) < 0.001 ? 3 : 2);
  if (f === "dec") return v.toFixed(1);
  if (f === "hours") return fmtHours(v);
  return fmtInt(v);
}

// "+12%" for counts, "+0.03 pts" for percentages; null when there is nothing to compare.
export function fmtChange(m: Metric): string | null {
  if (m.noPrev || m.now == null || m.prev == null) return null;
  if (m.format === "pct") {
    const d = (m.now - m.prev) * 100;
    return `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} pts`;
  }
  if (m.prev === 0) return m.now === 0 ? "no change" : "new";
  const r = (m.now - m.prev) / Math.abs(m.prev);
  if (Math.abs(r) < 0.005) return "no change";
  return `${r >= 0 ? "+" : "−"}${Math.abs(r * 100).toFixed(0)}%`;
}

// up = better, down = worse, null = no change or no comparison.
export function trendOf(m: Metric): "up" | "down" | null {
  if (m.noPrev || m.now == null || m.prev == null || m.now === m.prev)
    return null;
  const better = m.now > m.prev;
  return (m.lowerIsBetter ? !better : better) ? "up" : "down";
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const n = (v: number, one: string) =>
  `${fmtInt(v)} ${v === 1 ? one : `${one}s`}`;
const dayLabel = (iso: string | null) =>
  iso ? fmtDate(`${istDay(iso)}T12:00:00+05:30`, true) : "";

// "1,287 (organic 1,287, sponsored 0)", or a note when nothing was uploaded for the period.
export function followerLine(f: FollowerSplit): string {
  if (f.total == null) return "no Followers export uploaded for this period";
  return `${fmtInt(f.total)} (organic ${f.organic == null ? "—" : fmtInt(f.organic)}, sponsored ${
    f.sponsored == null ? "—" : fmtInt(f.sponsored)
  })${f.days < f.of ? `; export has ${f.days} of ${f.of} days` : ""}`;
}

function metricLine(m: Metric, prevLabel: string): string {
  const c = fmtChange(m);
  return `- ${m.label}: ${fmtValue(m.now, m.format)}${m.note ? ` [${m.note}]` : ""}${m.low ? " (low data)" : ""}${
    m.noPrev
      ? ` (${NO_PREV})`
      : c
        ? ` (${c} vs ${fmtValue(m.prev, m.format)} in ${prevLabel})`
        : m.prev == null
          ? " (no earlier data)"
          : ""
  }`;
}

// Plain text for an email or a deck: short headed sections, one fact per line.
export function reportText(r: Report): string {
  const L: string[] = [];
  // Headings in capitals stand out in plain-text email; a handle keeps its own spelling.
  const section = (t: string, suffix = "") =>
    L.push("", `${t.toUpperCase()}${suffix}`);
  L.push(
    `Resonia social media report, ${r.label}`,
    `Compared with the previous ${r.prevLabel}${r.anyPrev ? `, where there is comparable earlier data` : ` (${NO_PREV})`}`,
  );

  section("Key numbers");
  for (const m of r.kpis) L.push(metricLine(m, r.prevLabel));

  section("Highlights");
  if (!r.highlights.length) L.push("- Nothing stood out in this period");
  for (const h of r.highlights.slice(0, 8))
    L.push(`- ${h.text}${h.url ? ` ${h.url}` : ""}`);

  const tops = (title: string, list: TopPost[]) => {
    section(title);
    if (!list.length) L.push("- No posts in this period");
    list.forEach((t, i) =>
      L.push(
        `${i + 1}. ${t.brand.name}, ${dayLabel(t.post.posted_at)}: "${clip(t.post.text || "(no text)", 100)}"${originNote(t.post)}`,
        `   ${n(t.post.likes, "like")}, ${n(t.post.comments, "comment")}, ${n(t.post.reposts, "repost")}, ${fmtRate(t.rate)} follower engagement rate${reachNote(t)}`,
        `   ${t.post.url}`,
      ),
    );
  };
  tops("Top Resonia posts", r.top.montra);
  tops("Top competitor posts", r.top.competitors);

  if (ORM_ENABLED) {
    section("Comments and reputation (ORM)");
    for (const m of r.orm.metrics) L.push(metricLine(m, r.prevLabel));
    L.push(
      `- Sentiment: ${r.orm.sentiment.map((s) => `${s.name} ${s.now}`).join(", ")}${
        r.orm.sentiment.some((s) => s.prev == null) ? ` (${NO_PREV})` : ""
      }`,
    );
    if (r.orm.flagged.length) {
      L.push("- Needing a response:");
      for (const c of r.orm.flagged.slice(0, 5)) {
        const link = c.url ?? (c.channel ? null : c.post_url);
        L.push(
          `  - [${c.channel === "x" ? "X, " : c.channel === "li_mention" ? "LinkedIn mention, " : ""}${c.sentiment}${
            c.handled ? ", handled" : ""
          }] ${c.name}: "${clip(c.text, 100)}"${link ? ` ${link}` : ""}`,
        );
      }
      if (r.orm.flagged.length > 5)
        L.push(`  - and ${r.orm.flagged.length - 5} more`);
    }
  }

  if (r.x.ready) {
    section("X", ` (@${r.x.handle})`);
    for (const m of r.x.metrics) L.push(metricLine(m, r.prevLabel));
  }

  if (r.reach.ready && r.reach.metrics.some((m) => m.now != null)) {
    section("Reach (Resonia LinkedIn pages)");
    L.push(
      `  ${r.reach.mode} page totals ${r.reach.label}; every post on a Resonia feed is organic. ${VIDEO_CTR_NOTE}. Competitors' impressions and clicks are not public; see public interactions above.`,
    );
    for (const m of r.reach.metrics)
      if (m.now != null) L.push(metricLine(m, r.prevLabel));
  }

  if (LI_EXPORTS_ENABLED) {
    section("New followers (Resonia LinkedIn pages)");
    L.push(
      "  From the uploaded Followers exports: organic / sponsored / total, as LinkedIn reports them.",
    );
    for (const f of r.newFollowers) L.push(`- ${f.page}: ${followerLine(f)}`);
  }

  if (ORM_ENABLED) {
    section("Earned vs owned");
    for (const m of r.earned.metrics) L.push(metricLine(m, r.prevLabel));
    if (r.earned.outlets.length) {
      L.push("- Media outlets:");
      for (const o of r.earned.outlets.slice(0, 8))
        L.push(
          `  - ${o.name} (${o.channel}): ${o.count}, last ${dayLabel(o.last)}${o.url ? ` ${o.url}` : ""}`,
        );
    }
  }

  section("Best time to post (Resonia, IST)");
  if (!r.bestTime.length) L.push("- No Resonia posts in this period");
  r.bestTime.forEach((s, i) =>
    L.push(
      `${i + 1}. ${fmtSlot(s)}: ${s.avg == null ? "—" : Math.round(s.avg)} likes + comments on average (${s.n} ${
        s.n === 1 ? "post" : "posts"
      }${s.low ? ", low data" : ""})`,
    ),
  );
  L.push("", `"Low data" = based on fewer than ${LOW_DATA} posts or replies.`);
  return L.join("\n");
}

function csvCell(v: string | number | null): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function reportCsv(r: Report): string {
  const rows: (string | number | null)[][] = [
    [
      "section",
      "item",
      "current",
      "previous",
      "change",
      "low_data",
      "link",
      "note",
    ],
  ];
  const raw = (m: Metric, v: number | null) =>
    v == null
      ? null
      : m.format === "pct"
        ? Number(v.toFixed(6))
        : Number(v.toFixed(2));
  const metrics = (section: string, list: Metric[]) =>
    list.forEach((m) =>
      rows.push([
        section,
        m.label,
        raw(m, m.now),
        m.noPrev ? null : raw(m, m.prev),
        m.noPrev ? NO_PREV : fmtChange(m),
        m.low ? "yes" : "",
        null,
        m.note ?? null,
      ]),
    );
  metrics("KPIs", r.kpis);
  for (const f of r.newFollowers)
    for (const k of ["organic", "sponsored", "total"] as const)
      rows.push([
        "New followers (LinkedIn export)",
        `${f.page}: ${k}`,
        f[k],
        null,
        null,
        null,
        null,
        f.days < f.of ? `export has ${f.days} of ${f.of} days` : null,
      ]);
  for (const h of r.highlights)
    rows.push(["Highlights", h.text, null, null, null, null, h.url ?? null]);
  const tops = (section: string, list: TopPost[]) =>
    list.forEach((t, i) =>
      rows.push([
        section,
        `${i + 1}. ${t.brand.name}, ${istDay(t.post.posted_at)}: ${clip(t.post.text, 80)}`,
        t.post.likes + t.post.comments,
        null,
        null,
        null,
        t.post.url,
      ]),
    );
  tops("Top Resonia posts (likes + comments)", r.top.montra);
  tops("Top competitor posts (likes + comments)", r.top.competitors);
  metrics("ORM", r.orm.metrics);
  for (const s of r.orm.sentiment)
    rows.push([
      "ORM sentiment",
      s.name,
      s.now,
      s.prev,
      s.prev == null ? NO_PREV : null,
      null,
      null,
    ]);
  metrics("X", r.x.metrics);
  metrics("Earned vs owned", r.earned.metrics);
  if (r.reach.ready) metrics(`Reach (${r.reach.label})`, r.reach.metrics);
  for (const o of r.earned.outlets)
    rows.push([
      "Media outlets",
      `${o.name} (${o.channel}), last ${istDay(o.last)}`,
      o.count,
      null,
      null,
      null,
      o.url,
    ]);
  for (const s of r.bestTime)
    rows.push([
      "Best time (Resonia, IST)",
      fmtSlot(s),
      s.avg == null ? null : Math.round(s.avg),
      null,
      null,
      s.low ? "yes" : "",
      null,
    ]);
  // BOM so Excel opens UTF-8 (₹, emoji, Hindi) correctly.
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}
