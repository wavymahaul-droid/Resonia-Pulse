// Monthly client report (the deck's blocks) on the Report page. Pure, safe in the browser.
//
// LinkedIn figures are LinkedIn's own, from the uploaded exports, in LinkedIn's "All" view (organic +
// sponsored): the export's daily total columns added up over the month, and LinkedIn's daily
// engagement rates combined by LinkedIn's impressions (LinkedIn's rate for the month). Nothing is
// re-derived from tracker counts. Competitor and "what worked" blocks use the tracker's public
// numbers (likes, comments, reposts), since LinkedIn does not publish other pages' analytics.
import type { DashBrand, DashPost, FollowerPoint, LiPageDay } from "@/lib/dashboard";
import { bestSlots, fmtSlot, formatOf, FORMATS, LOW_DATA, timeGrid, type Format } from "@/lib/insights";
import { brandStats, fmtInt, fmtPct, istDay, postsInRange } from "@/lib/metrics";
import { publicInteractions } from "@/lib/reach";
import { shiftDay, type DateRange } from "@/lib/range";
import { topRows, type TopPost } from "@/lib/top";
import { newFollowers } from "@/lib/followers";

// The deck's page columns, in its order.
export const DECK_PAGES = [
  { id: "resonia-li", label: "Resonia LinkedIn", short: "LinkedIn" },
  { id: "resonia-ig", label: "Instagram", short: "Instagram" },
  { id: "resonia-fb", label: "Facebook", short: "Facebook" },
] as const;

// Month-on-month figures entered from earlier decks (report_history). Also the built-in fallback
// until supabase/schema.sql adds the table.
export type HistoryRow = {
  brand: string;
  month: string; // YYYY-MM
  followerGrowth: number | null;
  engagement: number | null;
  impressions: number | null;
  posts: number | null;
  followerGrowthFromExport?: boolean; // follower growth filled in from the Followers exports
};
const seed = (brand: string, month: string, f: number, e: number, i: number, p: number): HistoryRow => ({
  brand,
  month,
  followerGrowth: f,
  engagement: e,
  impressions: i,
  posts: p,
});
// No earlier figures for Resonia: the monthly report needs Resonia's own LinkedIn analytics exports.
export const HISTORY_SEED: HistoryRow[] = [];

// A post row from an uploaded Content export ("All posts"), for counting posts as LinkedIn lists them.
export type ExportPostRow = { brand: string; created: string | null };

export type MonthlyInput = {
  month: string; // YYYY-MM
  days: LiPageDay[]; // uploaded daily page numbers
  exportPosts: ExportPostRow[];
  history: HistoryRow[];
  posts: DashPost[]; // feed posts (ads excluded)
  brands: DashBrand[];
  followers: FollowerPoint[];
};

// ---------- months ----------

const pad = (n: number) => String(n).padStart(2, "0");
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number);
  const i = y * 12 + (m - 1) + by;
  return `${Math.floor(i / 12)}-${pad((i % 12) + 1)}`;
}
export function monthRange(month: string): DateRange {
  return { key: "custom", from: `${month}-01`, to: shiftDay(`${shiftMonth(month, 1)}-01`, -1) };
}
export const daysInMonth = (month: string) => Number(monthRange(month).to.slice(8, 10));
export function monthLabel(month: string, short = false): string {
  return new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-IN", {
    month: short ? "short" : "long",
    year: "numeric",
    timeZone: "UTC",
  });
}
// The month to show by default: the last complete month (IST).
export const defaultMonth = (today: string) => shiftMonth(today.slice(0, 7), -1);
export const isMonth = (s: string | null | undefined): s is string => !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

// ---------- LinkedIn's numbers for a page and month ----------

export type LiMonth = {
  days: number; // days of the month in the uploaded exports
  of: number; // days in the month
  impressions: number | null;
  likes: number | null; // LinkedIn's reactions
  comments: number | null;
  reposts: number | null;
  clicks: number | null;
  engagement: number | null; // LinkedIn's engagements: clicks + reactions + comments + reposts
  er: number | null; // LinkedIn's engagement rate for the month
  newFollowers: number | null;
  posts: number | null; // posts in the Content export, by created date
};

export function liMonth(input: Pick<MonthlyInput, "days" | "exportPosts">, brand: string, month: string): LiMonth {
  const rows = input.days.filter((d) => d.brand === brand && d.date.startsWith(month));
  const content = rows.filter((r) => r.impressions != null);
  const sum = (list: LiPageDay[], k: keyof LiPageDay) => {
    const v = list.map((r) => r[k]).filter((x): x is number => typeof x === "number");
    return v.length ? v.reduce((a, b) => a + b, 0) : null;
  };
  const [clicks, likes, comments, reposts] = (["clicks", "reactions", "comments", "reposts"] as const).map((k) =>
    sum(content, k),
  );
  const impressions = sum(content, "impressions");
  // LinkedIn's own daily rates, weighted by its impressions: LinkedIn's rate for the whole month.
  const rated = content.filter((r) => r.engagement_rate != null && r.impressions != null);
  const ratedImpr = rated.reduce((a, r) => a + (r.impressions as number), 0);
  const er = ratedImpr
    ? rated.reduce((a, r) => a + Number(r.engagement_rate) * (r.impressions as number), 0) / ratedImpr
    : null;
  const engagement =
    clicks == null && likes == null ? null : (clicks ?? 0) + (likes ?? 0) + (comments ?? 0) + (reposts ?? 0);
  const posts = input.exportPosts.filter((p) => p.brand === brand && p.created?.startsWith(month)).length;
  return {
    days: new Set(content.map((r) => r.date)).size,
    of: daysInMonth(month),
    impressions,
    likes,
    comments,
    reposts,
    clicks,
    engagement,
    er,
    newFollowers: sum(rows, "new_followers"),
    posts: content.length || posts ? posts : null,
  };
}

// ---------- blocks ----------

export type Cell = string | number | null;
export type Fmt = "int" | "pct" | "dec" | "text";
export type Row = { label: string; cells: Cell[]; fmt: Fmt | Fmt[]; src?: ("export" | "history" | null)[] };
export type Table = { title?: string; head: string[]; rows: Row[]; notes?: string[] };
export type PostItem = {
  page: string;
  date: string;
  text: string;
  url: string;
  image: string | null;
  stats: string;
  file: string; // file name in the thumbnails download
};
export type Block = { id: string; title: string; sub: string; tables: Table[]; posts?: PostItem[]; notes?: string[] };

export function fmtCell(v: Cell, f: Fmt): string {
  if (v == null || v === "") return "";
  if (typeof v === "string" || f === "text") return String(v);
  if (f === "pct") return fmtPct(v, 2);
  if (f === "dec") return v.toFixed(1);
  return fmtInt(Math.round(v));
}
const fmtOf = (r: Row, i: number): Fmt => (Array.isArray(r.fmt) ? r.fmt[i] : r.fmt);

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const mean = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

// Most-used key, ties broken by public interactions.
function topBy(posts: DashPost[], key: (p: DashPost) => string): string | null {
  const m = new Map<string, { n: number; i: number }>();
  for (const p of posts) {
    const k = key(p);
    const o = m.get(k) ?? { n: 0, i: 0 };
    m.set(k, { n: o.n + 1, i: o.i + publicInteractions(p) });
  }
  return [...m].sort((a, b) => b[1].n - a[1].n || b[1].i - a[1].i)[0]?.[0] ?? null;
}

export type Monthly = {
  month: string;
  label: string;
  months: string[]; // the 3 months of the MoM tables, oldest first
  overall: Block;
  mom: Block;
  competitors: Block;
  worked: Block;
  topPosts: Block;
};

export function buildMonthly(input: MonthlyInput): Monthly {
  const { month, brands } = input;
  const range = monthRange(month);
  const label = monthLabel(month);
  const name = (id: string) => brands.find((b) => b.id === id)?.name ?? id;
  const li = new Map(DECK_PAGES.map((p) => [p.id, liMonth(input, p.id, month)]));
  // Follower engagement rates use each page's followers at month end; a page with no count by then
  // (counts start with daily tracking) uses its first count after the month, and a note says so.
  const borrowed = new Map<string, string>();
  const followers = [...input.followers];
  for (const b of brands) {
    const own = input.followers.filter((f) => f.brand === b.id && f.followers > 0);
    if (own.some((f) => f.date <= range.to)) continue;
    const next = own.filter((f) => f.date > range.to).sort((x, y) => x.date.localeCompare(y.date))[0];
    if (!next) continue;
    borrowed.set(b.id, next.date);
    followers.push({ ...next, date: range.to });
  }
  followers.sort((x, y) => x.date.localeCompare(y.date));
  const borrowedNote = borrowed.size
    ? `No follower counts were recorded by the end of ${label} for ${borrowed.size} ${
        borrowed.size === 1 ? "page" : "pages"
      }, so follower engagement rates use each page's first count after the month (from ${[
        ...new Set(borrowed.values()),
      ]
        .sort()
        .map((d) => fmtDay(d))
        .join(", ")}).`
    : null;
  // Pages whose month comes from the exports (not the entered history) and that miss some days.
  const exportNote = (m: string) => {
    const complete = (h: HistoryRow) =>
      h.followerGrowth != null && h.engagement != null && h.impressions != null && h.posts != null;
    const short = DECK_PAGES.filter((p) => !input.history.some((h) => h.brand === p.id && h.month === m && complete(h)))
      .map((p) => [p.short, liMonth(input, p.id, m)] as const)
      .filter(([, l]) => l.days < l.of);
    return short.length
      ? `Uploaded exports cover only part of ${monthLabel(m)}: ${short.map(([s, l]) => `${s} ${l.days} of ${l.of} days`).join(", ")}.`
      : null;
  };

  // 1. Overall performance, and new followers per page (organic / sponsored / total).
  const follows = DECK_PAGES.map((p) => newFollowers(input.days, p.id, range));
  const cols = DECK_PAGES.map((p) => li.get(p.id)!);
  const row = (label: string, f: (l: LiMonth) => number | null, fmt: Fmt): Row => ({
    label,
    cells: [...cols.map(f), null],
    fmt,
  });
  const overall: Block = {
    id: "overall",
    title: "Overall performance",
    sub: `${label} · LinkedIn analytics, All (organic + sponsored), from the uploaded exports`,
    tables: [
      {
        head: ["", ...DECK_PAGES.map((p) => p.label), "X"],
        rows: [
          row("No. of posts", (l) => l.posts, "int"),
          row("Engagement", (l) => l.engagement, "int"),
          row("Likes", (l) => l.likes, "int"),
          row("Comments", (l) => l.comments, "int"),
          row("Reposts", (l) => l.reposts, "int"),
          row("Engagement rate", (l) => l.er, "pct"),
          row("Impressions", (l) => l.impressions, "int"),
        ],
      },
      {
        title: "New followers (LinkedIn Followers export)",
        head: ["", ...DECK_PAGES.map((p) => p.label), "All Resonia pages"],
        rows: (["organic", "sponsored", "total"] as const).map((k) => {
          const vals = follows.map((f) => f[k]);
          const known = vals.filter((v): v is number => v != null);
          return {
            label: k === "total" ? "Total" : k[0].toUpperCase() + k.slice(1),
            cells: [...vals, known.length ? known.reduce((x, y) => x + y, 0) : null],
            fmt: "int" as const,
          };
        }),
      },
    ],
    notes: [
      "Engagement = clicks + reactions + comments + reposts (LinkedIn's engagements). Engagement rate is LinkedIn's own rate for the month (its daily rates, weighted by its impressions), so it can include sponsored follows that the engagement count does not. Impressions are LinkedIn's page impressions. No. of posts = posts in the Content export, by created date. The X column is left for you to fill in.",
      ...[exportNote(month)].filter((x): x is string => !!x),
    ],
  };

  // 2. Month on month, per page: entered history wins, else the exports.
  const months = [shiftMonth(month, -2), shiftMonth(month, -1), month];
  const monthPosts = postsInRange(input.posts, range);
  const averages: Row[] = [];
  const momTables: Table[] = DECK_PAGES.map((p) => {
    // Field by field: a figure in the report history wins (as entered, or filled from the Followers
    // exports), else the uploaded exports.
    type Src = "export" | "history" | null;
    const vals = months.map((m) => {
      const h = input.history.find((x) => x.brand === p.id && x.month === m);
      const l = liMonth(input, p.id, m);
      const has = l.days > 0 || !!l.posts;
      const pick = (hv: number | null | undefined, lv: number | null, fromExport = false): [number | null, Src] =>
        hv != null ? [hv, fromExport ? "export" : "history"] : has && lv != null ? [lv, "export"] : [null, null];
      return {
        f: pick(h?.followerGrowth, l.newFollowers, !!h?.followerGrowthFromExport),
        e: pick(h?.engagement, l.engagement),
        i: pick(h?.impressions, l.impressions),
        n: pick(h?.posts, l.posts),
      };
    });
    const r = (label: string, k: "f" | "e" | "i" | "n"): Row => ({
      label,
      cells: [...vals.map((v) => v[k][0]), mean(vals.map((v) => v[k][0]))],
      fmt: [...months.map(() => "int" as const), k === "n" ? ("dec" as const) : ("int" as const)],
      src: [...vals.map((v) => v[k][1]), null],
    });
    averages.push({
      label: p.label,
      cells: (["f", "e", "i", "n"] as const).map((k) => mean(vals.map((v) => v[k][0]))),
      fmt: ["int", "int", "int", "dec"],
    });
    // The month's top themes on this page (tracker posts).
    const own = monthPosts.filter((x) => x.brand === p.id);
    const themes = new Map<string, DashPost[]>();
    for (const x of own) themes.set(x.theme, [...(themes.get(x.theme) ?? []), x]);
    const top = [...themes]
      .map(([t, list]) => ({ t, n: list.length, avg: mean(list.map(publicInteractions)) ?? 0 }))
      .sort((a, b) => b.n - a.n || b.avg - a.avg)
      .slice(0, 3);
    return {
      title: p.label,
      head: ["", ...months.map((m) => monthLabel(m, true)), "3-month average"],
      rows: [r("Follower growth", "f"), r("Engagement", "e"), r("Impressions", "i"), r("No. of posts", "n")],
      notes: [
        top.length
          ? `Top themes in ${monthLabel(month)}: ${top
              .map(
                (x) =>
                  `${x.t} (${x.n} ${x.n === 1 ? "post" : "posts"}, ${fmtInt(Math.round(x.avg))} avg public interactions)`,
              )
              .join("; ")}`
          : `No posts tracked on this page in ${monthLabel(month)}.`,
      ],
    };
  });
  const mom: Block = {
    id: "mom",
    title: "Month on month, per page",
    sub: `${months.map((m) => monthLabel(m, true)).join(", ")} · LinkedIn: new followers, engagements, page impressions, posts`,
    tables: [
      ...momTables,
      {
        title: "3-month averages per page",
        head: ["", "Follower growth", "Engagement", "Impressions", "No. of posts"],
        rows: averages,
      },
    ],
    notes: [
      "Figures in the report history are used as stored (·e = entered from earlier decks); follower growth is filled in from each page's Followers export for every full month uploaded. Anything else comes from the uploaded exports (All view).",
      ...months.map(exportNote).filter((x): x is string => !!x),
    ],
  };

  // 3. Competitors (tracker's public numbers).
  const comps = brands.filter((b) => !b.is_montra);
  const montraIds = new Set(brands.filter((b) => b.is_montra).map((b) => b.id));
  const stats = brandStats(comps, monthPosts, followers, range);
  const compPosts = monthPosts.filter((p) => !montraIds.has(p.brand));
  const montraPosts = monthPosts.filter((p) => montraIds.has(p.brand));
  const interactions = (list: DashPost[]) => list.reduce((a, p) => a + publicInteractions(p), 0);
  const allInteractions = interactions(monthPosts);
  const share = (list: DashPost[]) => (allInteractions ? interactions(list) / allInteractions : null);
  const perComp: Row[] = stats.map((s) => {
    const own = compPosts.filter((p) => p.brand === s.brand.id);
    return {
      label: s.brand.name,
      cells: [
        own.length,
        own.length ? interactions(own) / own.length : null,
        s.engagementRate,
        topBy(own, (p) => p.theme),
        topBy(own, (p) => formatOf(p.media)),
      ],
      fmt: ["int", "dec", "pct", "text", "text"],
    };
  });
  const mix = (key: (p: DashPost) => string, keys: readonly string[]): Row[] =>
    keys
      .map((k) => {
        const m = montraPosts.filter((p) => key(p) === k).length;
        const c = compPosts.filter((p) => key(p) === k).length;
        return {
          label: k,
          cells: [
            m,
            montraPosts.length ? m / montraPosts.length : null,
            c,
            compPosts.length ? c / compPosts.length : null,
          ],
          fmt: ["int", "pct", "int", "pct"] as Fmt[],
        };
      })
      .filter((r) => (r.cells[0] as number) + (r.cells[2] as number) > 0);
  const themeKeys = [...new Set(monthPosts.map((p) => p.theme))].sort(
    (a, b) => monthPosts.filter((p) => p.theme === b).length - monthPosts.filter((p) => p.theme === a).length,
  );
  const standout = [...compPosts]
    .sort((a, b) => publicInteractions(b) - publicInteractions(a) || b.posted_at.localeCompare(a.posted_at))
    .slice(0, 3);
  const competitors: Block = {
    id: "competitors",
    title: "Competitor summary",
    sub: `${label} · public numbers (likes, comments, reposts); competitors' impressions and clicks are not public`,
    tables: [
      {
        head: ["Competitor", "Posts", "Avg public interactions", "Follower engagement rate", "Top theme", "Top format"],
        rows: perComp,
      },
      {
        title: "Share of voice (public interactions)",
        head: ["", "Public interactions", "Share"],
        rows: [
          { label: "Resonia (all pages)", cells: [interactions(montraPosts), share(montraPosts)], fmt: ["int", "pct"] },
          ...comps.map((b) => {
            const own = compPosts.filter((p) => p.brand === b.id);
            return { label: b.name, cells: [interactions(own), share(own)], fmt: ["int", "pct"] as Fmt[] };
          }),
        ],
      },
      {
        title: "Theme mix",
        head: ["Theme", "Resonia posts", "Resonia %", "Competitor posts", "Competitor %"],
        rows: mix((p) => p.theme, themeKeys),
      },
      {
        title: "Format mix",
        head: ["Format", "Resonia posts", "Resonia %", "Competitor posts", "Competitor %"],
        rows: mix((p) => formatOf(p.media), FORMATS),
      },
      {
        title: "Standout competitor posts",
        head: ["#", "Competitor", "Date", "Post", "Public interactions", "Link"],
        rows: standout.map((p, i) => ({
          label: String(i + 1),
          cells: [name(p.brand), istDay(p.posted_at), clip(p.text || "(no text)", 100), publicInteractions(p), p.url],
          fmt: ["text", "text", "text", "int", "text"],
        })),
      },
    ],
    posts: standout.map((p, i) => ({
      page: name(p.brand),
      date: istDay(p.posted_at),
      text: p.text,
      url: p.url,
      image: p.image,
      stats: `${fmtInt(publicInteractions(p))} public interactions (${fmtInt(p.likes)} likes, ${fmtInt(p.comments)} comments, ${fmtInt(p.reposts)} reposts)`,
      file: `competitor-${i + 1}-${slug(name(p.brand))}-${istDay(p.posted_at)}`,
    })),
    notes: [
      "Avg public interactions = (likes + comments + reposts) ÷ posts. Follower engagement rate = (likes + comments) per post ÷ page followers at month end. Share of voice = share of all public interactions on Resonia's and the competitors' posts.",
      ...(borrowedNote ? [borrowedNote] : []),
    ],
  };

  // 4. What worked for us (tracker's public numbers, Resonia posts).
  const rows: TopPost[] = topRows(input.posts, brands, followers, range).filter((r) => r.brand.is_montra);
  const aggOf = (list: TopPost[]) => ({
    n: list.length,
    avg: mean(list.map((r) => r.post.likes + r.post.comments)),
    rate: mean(list.map((r) => r.rate)),
  });
  const byFormat = FORMATS.map((f) => ({ f, ...aggOf(rows.filter((r) => formatOf(r.post.media) === f)) })).filter(
    (x) => x.n,
  );
  const themeAgg = [...new Set(rows.map((r) => r.post.theme))]
    .map((t) => ({ t, ...aggOf(rows.filter((r) => r.post.theme === t)) }))
    .sort((a, b) => Number(a.n < 2) - Number(b.n < 2) || (b.avg ?? 0) - (a.avg ?? 0))
    .slice(0, 3);
  const slots = bestSlots(timeGrid(rows));
  const lowNote = (n: number) => (n < LOW_DATA ? "low data" : "");
  const worked: Block = {
    id: "worked",
    title: "What worked for us",
    sub: `${label} · Resonia posts on all four pages, by average likes + comments`,
    tables: [
      {
        title: "Format performance",
        head: ["Format", "Posts", "Avg likes + comments", "Follower engagement rate", ""],
        rows: byFormat.map((x) => ({
          label: x.f,
          cells: [x.n, x.avg, x.rate, lowNote(x.n)],
          fmt: ["int", "dec", "pct", "text"],
        })),
      },
      {
        title: "Top 3 posting slots (IST)",
        head: ["Slot", "Posts", "Avg likes + comments", ""],
        rows: slots.map((s) => ({
          label: fmtSlot(s),
          cells: [s.n, s.avg, s.low ? "low data" : ""],
          fmt: ["int", "dec", "text"],
        })),
      },
      {
        title: "Top 3 themes",
        head: ["Theme", "Posts", "Avg likes + comments", "Follower engagement rate", ""],
        rows: themeAgg.map((x) => ({
          label: x.t,
          cells: [x.n, x.avg, x.rate, lowNote(x.n)],
          fmt: ["int", "dec", "pct", "text"],
        })),
      },
    ],
    notes: [
      `"Low data" = fewer than ${LOW_DATA} posts. Themes with a single post rank after the others.`,
      ...(borrowedNote ? [borrowedNote] : []),
    ],
  };

  // 5. Top LinkedIn posts: Resonia's top 3 by LinkedIn's engagements, from the export.
  const liEng = (p: DashPost) =>
    p.li?.clicks == null
      ? null
      : (p.li.clicks ?? 0) + (p.li.reactions ?? 0) + (p.li.comments ?? 0) + (p.li.reposts ?? 0);
  const best = montraPosts
    .filter((p) => liEng(p) != null)
    .sort((a, b) => liEng(b)! - liEng(a)! || (b.li?.impressions ?? 0) - (a.li?.impressions ?? 0))
    .slice(0, 3);
  const topPosts: Block = {
    id: "top-posts",
    title: "Top LinkedIn posts",
    sub: `${label} · Resonia's top 3 by LinkedIn engagements, as LinkedIn reports them (uploaded export)`,
    tables: [
      {
        head: ["#", "Page", "Date", "Post", "Impressions", "Engagements", "Engagement rate", "Link"],
        rows: best.map((p, i) => ({
          label: String(i + 1),
          cells: [
            name(p.brand),
            istDay(p.posted_at),
            clip(p.text || "(no text)", 100),
            p.li!.impressions,
            liEng(p),
            p.li!.engagementRate,
            p.url,
          ],
          fmt: ["text", "text", "text", "int", "int", "pct", "text"],
        })),
      },
    ],
    posts: best.map((p, i) => ({
      page: name(p.brand),
      date: istDay(p.posted_at),
      text: p.text,
      url: p.url,
      image: p.image,
      stats: `${fmtInt(p.li!.impressions)} impressions · ${fmtInt(liEng(p))} engagements · ${
        p.li!.engagementRate == null ? "—" : fmtPct(p.li!.engagementRate, 2)
      } engagement rate (LinkedIn)`,
      file: `montra-${i + 1}-${slug(name(p.brand))}-${istDay(p.posted_at)}`,
    })),
    notes: [
      best.length
        ? "Engagements = clicks + reactions + comments + reposts from the export row; impressions and engagement rate are LinkedIn's."
        : `No Resonia posts from ${label} in an uploaded Content export yet.`,
    ],
  };

  return { month, label, months, overall, mom, competitors, worked, topPosts };
}

// ---------- copy and CSV ----------

// Plain text: the block title, then each table as tab-separated rows (pastes into deck tables).
export function blockText(b: Block): string {
  const L = [b.title.toUpperCase(), b.sub];
  for (const t of b.tables) {
    L.push("");
    if (t.title) L.push(t.title);
    L.push(t.head.join("\t"));
    if (!t.rows.length) L.push("(none)");
    for (const r of t.rows) L.push([r.label, ...r.cells.map((c, i) => fmtCell(c, fmtOf(r, i)))].join("\t"));
    for (const n of t.notes ?? []) L.push(n);
  }
  for (const n of b.notes ?? []) L.push("", n);
  return L.join("\n");
}

function csvCell(v: Cell): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// CSV: raw numbers (rates as fractions), one header row per table.
export function blockCsv(b: Block): string {
  const rows: Cell[][] = [];
  for (const t of b.tables) {
    rows.push(["table", ...t.head.map((h, i) => (i === 0 && !h ? "item" : h))]);
    for (const r of t.rows)
      rows.push([
        t.title ?? b.title,
        r.label,
        ...r.cells.map((c) => (typeof c === "number" ? Number(c.toFixed(6)) : c)),
      ]);
  }
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}
