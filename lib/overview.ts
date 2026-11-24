// The visual Overview on the dashboard home: KPI tiles, where we stand, themes, this week's
// standouts and today's signals. Pure functions over data already stored (no Apify, no AI), so
// everything re-renders in the browser when the range or segment changes.
import { previousRange } from "@/lib/analytics";
import { ORM_ENABLED, POSTS_BACKFILLED_FROM } from "@/lib/brands";
import type { DashBrand, DashComment, DashPost, FollowerPoint, LiExportData, LiPageDay } from "@/lib/dashboard";
import { newFollowers, pageFollowersAt } from "@/lib/followers";
import { highlights } from "@/lib/insights";
import { fmtCompact as fmtCompactNum, fmtInt, istDay, postsInRange } from "@/lib/metrics";
import { isOpen } from "@/lib/orm";
import { inRange, rangeDays, shiftDay, type DateRange } from "@/lib/range";
import { pageTotals, publicInteractions } from "@/lib/reach";

const eng = (p: DashPost) => p.likes + p.comments;
const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d);
  return out;
};
const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

// A share of the previous period's days with export data below this is too little to compare.
const MIN_COVERED = 0.9;
export const ORGANIC_TIP = "Organic only. Monthly client report uses LinkedIn's All view, organic + sponsored";
// A post only counts as a "standout" at this many times its page average.
export const STANDOUT_MULTIPLE = 1.5;
// The export is "old" after this many days without new data.
export const STALE_DAYS = 10;

// ---------- KPI tiles ----------

export type Tile = {
  key: "impressions" | "engagements" | "followers" | "sov" | "pace";
  label: string;
  valueText?: string; // shown instead of the value (e.g. "8.3 vs 17.6")
  extra?: { line: string; pages?: string; tip?: string }; // lines under the value
  tip?: string; // shown on hover over the label
  value: number | null;
  pct: boolean; // a share (shown as %; change in points)
  change: number | null; // ratio (+0.12 = +12%) or, for shares, points (0.02 = +2 pts)
  noPrev: boolean; // the previous period has too little data to compare
  spark: { date: string; v: number | null }[]; // the 30 days to the range end
  foot: string; // source line
  lastExport?: string | null; // latest day in the uploaded exports (export tiles)
  stale?: boolean; // that day is more than STALE_DAYS ago
};

export function overviewTiles({
  li,
  posts,
  brands,
  range,
  today,
  followers = [],
}: {
  li: LiExportData;
  posts: DashPost[];
  brands: DashBrand[]; // the segment's pages
  range: DateRange;
  today: string;
  followers?: FollowerPoint[]; // scraped daily follower counts
}): Tile[] {
  const prev = previousRange(range);
  const montra = brands.filter((b) => b.is_montra).map((b) => b.id);
  const sparkDays = days(shiftDay(range.to, -29), range.to);
  const pages = li.pages.filter((d) => montra.includes(d.brand));
  const latest = (pick: (d: LiPageDay) => unknown) =>
    pages
      .filter((d) => pick(d) != null)
      .map((d) => d.date)
      .sort()
      .at(-1) ?? null;
  const stale = (d: string | null) => !d || rangeDays({ key: "custom", from: d, to: today }) - 1 > STALE_DAYS;
  const ratio = (now: number | null, before: number | null) =>
    now == null || before == null || before === 0 ? null : (now - before) / Math.abs(before);
  const exportDays = (r: DateRange, pick: (d: LiPageDay) => unknown) =>
    new Set(pages.filter((d) => inRange(d.date, r) && pick(d) != null).map((d) => d.date)).size;
  const covered = (r: DateRange, pick: (d: LiPageDay) => unknown) => exportDays(r, pick) >= MIN_COVERED * rangeDays(r);

  // Organic page totals (paid campaigns are dark posts; their numbers are in the sponsored columns).
  const t = pageTotals(li, range, montra, "organic");
  const tp = pageTotals(li, prev, montra, "organic");
  const dayTotal = (d: string, k: "impressions" | "engagements") => {
    const one = pageTotals(li, { key: "custom", from: d, to: d }, montra, "organic");
    return one.days ? one[k] : null;
  };
  const content = (d: LiPageDay) => d.impressions;
  const contentLast = latest(content);
  const label = (n: number, of: number) => (n < of ? ` · export has ${n} of ${of} days` : "");

  const nf = (r: DateRange) => {
    const list = montra.map((id) => newFollowers(li.pages, id, r)).filter((f) => f.total != null);
    return list.length ? sumOf(list.map((f) => f.total as number)) : null;
  };
  const follows = (d: LiPageDay) => d.new_followers;
  const followsLast = latest(follows);

  // Share of voice: Resonia's share of all public interactions on posts published in the range.
  const inPages = (list: DashPost[]) => list.filter((p) => brands.some((b) => b.id === p.brand));
  const sov = (list: DashPost[]) => {
    const all = sumOf(list.map(publicInteractions));
    return all ? sumOf(list.filter((p) => montra.includes(p.brand)).map(publicInteractions)) / all : null;
  };
  const nowPosts = inPages(postsInRange(posts, range));

  // Posts per page: Resonia's pages vs the competitors' average.
  const compIds = brands.filter((b) => !b.is_montra).map((b) => b.id);
  const pace = (r: DateRange) => {
    const list = postsInRange(posts, r);
    const per = (ids: string[]) => (ids.length ? list.filter((p) => ids.includes(p.brand)).length / ids.length : null);
    return { montra: per(montra), comp: per(compIds) };
  };
  const paceNow = pace(range);
  const perWeek = (d: string) => (montra.length ? pace({ key: "custom", from: shiftDay(d, -6), to: d }).montra : null);

  // Total followers on the Resonia pages at the range end, per page (Corporate · Truck · SCV · Tractor).
  const followerExtra = () => {
    const SHORT: Record<string, string> = { linkedin: "LinkedIn", instagram: "Instagram", facebook: "Facebook", x: "X" };
    const order = ["linkedin", "instagram", "facebook", "x"];
    const pages = brands
      .filter((b) => b.is_montra)
      .sort((a, b) => order.indexOf(a.segment) - order.indexOf(b.segment))
      .map((b) => ({ b, f: pageFollowersAt(followers, li.pages, b.id, range.to) }));
    const known = pages.filter((p) => p.f.value != null);
    if (!known.length) return undefined;
    const total = sumOf(known.map((p) => p.f.value as number));
    const asOf = [...new Set(known.map((p) => p.f.asOf).filter((x): x is string => !!x))].sort();
    const estimated = known.some((p) => p.f.estimated);
    return {
      line: `Total followers: ${fmtInt(total)}`,
      pages: known.map((p) => `${SHORT[p.b.segment] ?? p.b.name} ${fmtCompactNum(p.f.value as number)}`).join(" · "),
      tip: asOf.length
        ? `No count by ${fmtDay(range.to)}: the count on ${asOf.map(fmtDay).join(", ")} is used`
        : estimated
          ? "Estimated: next count minus LinkedIn new followers (export)"
          : `Scraped counts on ${fmtDay(range.to)} or the last day before`,
    };
  };
  const sovNow = sov(nowPosts);
  const sovPrev = sov(inPages(postsInRange(posts, prev)));
  const byDay = new Map<string, DashPost[]>();
  for (const p of inPages(posts)) {
    const d = istDay(p.posted_at);
    byDay.set(d, [...(byDay.get(d) ?? []), p]);
  }

  return [
    {
      key: "impressions",
      label: "Organic impressions",
      tip: ORGANIC_TIP,
      value: t.impressions,
      pct: false,
      change: ratio(t.impressions, tp.impressions),
      noPrev: !covered(prev, content),
      spark: sparkDays.map((d) => ({ date: d, v: dayTotal(d, "impressions") })),
      foot: `Organic page impressions${label(t.days, rangeDays(range))}`,
      lastExport: contentLast,
      stale: stale(contentLast),
    },
    {
      key: "engagements",
      label: "Organic engagements",
      tip: ORGANIC_TIP,
      value: t.engagements,
      pct: false,
      change: ratio(t.engagements, tp.engagements),
      noPrev: !covered(prev, content),
      spark: sparkDays.map((d) => ({ date: d, v: dayTotal(d, "engagements") })),
      foot: `Reactions + comments + reposts + clicks${label(t.days, rangeDays(range))}`,
      lastExport: contentLast,
      stale: stale(contentLast),
    },
    {
      key: "followers",
      label: "Resonia new followers",
      value: nf(range),
      pct: false,
      change: ratio(nf(range), nf(prev)),
      noPrev: !covered(prev, follows),
      spark: sparkDays.map((d) => ({ date: d, v: nf({ key: "custom", from: d, to: d }) })),
      foot: `LinkedIn new followers, all pages${label(exportDays(range, follows), rangeDays(range))}`,
      extra: followerExtra(),
      lastExport: followsLast,
      stale: stale(followsLast),
    },
    {
      key: "sov",
      label: "Resonia share of voice",
      value: sovNow,
      pct: true,
      change: sovNow != null && sovPrev != null ? sovNow - sovPrev : null,
      noPrev: prev.from < POSTS_BACKFILLED_FROM,
      spark: sparkDays.map((d) => ({ date: d, v: sov(byDay.get(d) ?? []) })),
      foot: "Share of public interactions (reactions + comments + reposts)",
    },
    {
      key: "pace",
      label: "Posting pace",
      value: paceNow.montra,
      valueText:
        paceNow.montra == null
          ? undefined
          : `${paceNow.montra.toFixed(1)} vs ${paceNow.comp == null ? "—" : paceNow.comp.toFixed(1)}`,
      pct: false,
      change: ratio(paceNow.montra, pace(prev).montra),
      noPrev: prev.from < POSTS_BACKFILLED_FROM,
      spark: sparkDays.map((d) => ({ date: d, v: perWeek(d) })),
      foot: "Resonia posts per page vs competitor average, this period · line: Resonia posts per page, trailing 7 days",
    },
  ];
}

// ---------- where we stand ----------

export type Slice = { name: string; value: number; share: number; kind: "montra" | "comp" | "others" };

// Resonia's pages combined, the top 5 competitors and everyone else, by public interactions.
export function sovSlices(posts: DashPost[], brands: DashBrand[], range: DateRange, top = 5): Slice[] {
  const list = postsInRange(posts, range).filter((p) => brands.some((b) => b.id === p.brand));
  const total = sumOf(list.map(publicInteractions));
  if (!total) return [];
  const by = (ids: string[]) => sumOf(list.filter((p) => ids.includes(p.brand)).map(publicInteractions));
  const montra = by(brands.filter((b) => b.is_montra).map((b) => b.id));
  const comps = brands
    .filter((b) => !b.is_montra)
    .map((b) => ({ name: b.name, value: by([b.id]) }))
    .sort((a, b) => b.value - a.value);
  const head = comps.slice(0, top).filter((c) => c.value > 0);
  const rest = sumOf(comps.slice(head.length).map((c) => c.value));
  return [
    { name: "Resonia (all pages)", value: montra, share: montra / total, kind: "montra" as const },
    ...head.map((c) => ({ ...c, share: c.value / total, kind: "comp" as const })),
    ...(rest ? [{ name: "Others", value: rest, share: rest / total, kind: "others" as const }] : []),
  ];
}

export type PageAvg = { id: string; name: string; montra: boolean; avg: number; posts: number };

// Average likes + comments per post for each page, highest first (pages without posts last).
export function pageAverages(posts: DashPost[], brands: DashBrand[], range: DateRange): PageAvg[] {
  const list = postsInRange(posts, range);
  return brands
    .map((b) => {
      const own = list.filter((p) => p.brand === b.id);
      return {
        id: b.id,
        name: b.name,
        montra: b.is_montra,
        posts: own.length,
        avg: own.length ? sumOf(own.map(eng)) / own.length : 0,
      };
    })
    .sort((a, b) => Number(!a.posts) - Number(!b.posts) || b.avg - a.avg);
}

// ---------- themes ----------

export type ThemeShare = { theme: string; montra: number; comp: number };

// Share of posts per theme, Resonia vs competitors (each side adds up to 100%). The most-used themes,
// the rest folded into "Other themes".
export function themeShares(posts: DashPost[], brands: DashBrand[], range: DateRange, top = 7): ThemeShare[] {
  const list = postsInRange(posts, range).filter((p) => brands.some((b) => b.id === p.brand));
  const montraIds = new Set(brands.filter((b) => b.is_montra).map((b) => b.id));
  const m = list.filter((p) => montraIds.has(p.brand));
  const c = list.filter((p) => !montraIds.has(p.brand));
  const count = new Map<string, number>();
  for (const p of list) count.set(p.theme, (count.get(p.theme) ?? 0) + 1);
  const order = [...count].sort((a, b) => b[1] - a[1]).map(([t]) => t);
  const head = order.slice(0, top);
  const share = (side: DashPost[], f: (p: DashPost) => boolean) =>
    side.length ? side.filter(f).length / side.length : 0;
  const rows = head.map((t) => ({
    theme: t,
    montra: share(m, (p) => p.theme === t),
    comp: share(c, (p) => p.theme === t),
  }));
  if (order.length > top) {
    const rest = new Set(order.slice(top));
    rows.push({
      theme: "Other themes",
      montra: share(m, (p) => rest.has(p.theme)),
      comp: share(c, (p) => rest.has(p.theme)),
    });
  }
  return rows;
}

export type DailyPoint = { date: string; montra: number | null; comp: number | null };

// Likes + comments on posts published each day, per page: Resonia's average page vs the average
// competitor page, over the 30 days to the range end.
export function dailyEngagement(posts: DashPost[], brands: DashBrand[], to: string): DailyPoint[] {
  const m = brands.filter((b) => b.is_montra).map((b) => b.id);
  const c = brands.filter((b) => !b.is_montra).map((b) => b.id);
  const by = new Map<string, DashPost[]>();
  for (const p of posts) {
    const d = istDay(p.posted_at);
    by.set(d, [...(by.get(d) ?? []), p]);
  }
  const avg = (list: DashPost[], ids: string[]) =>
    ids.length ? sumOf(list.filter((p) => ids.includes(p.brand)).map(eng)) / ids.length : null;
  return days(shiftDay(to, -29), to).map((d) => {
    const list = by.get(d) ?? [];
    return { date: d, montra: avg(list, m), comp: avg(list, c) };
  });
}

// ---------- this week's standouts ----------

export type Standout = { post: DashPost; brand: DashBrand; value: number; pageAvg: number; multiple: number };

// The best Resonia post and the 2 best competitor posts of the last 7 days of the range, by how far
// they beat their own page's usual likes + comments (the page average over all loaded posts).
export function standouts(posts: DashPost[], brands: DashBrand[], range: DateRange): Standout[] {
  const avg = new Map<string, number>();
  for (const b of brands) {
    const own = posts.filter((p) => p.brand === b.id);
    if (own.length >= 3) avg.set(b.id, sumOf(own.map(eng)) / own.length);
  }
  const week: DateRange = { key: "custom", from: shiftDay(range.to, -6), to: range.to };
  const rows = postsInRange(posts, week).flatMap((p) => {
    const brand = brands.find((b) => b.id === p.brand);
    const a = avg.get(p.brand);
    return brand && a ? [{ post: p, brand, value: eng(p), pageAvg: a, multiple: eng(p) / a }] : [];
  });
  const rank = (list: Standout[]) => [...list].sort((x, y) => y.multiple - x.multiple || y.value - x.value);
  const montra = rank(rows.filter((r) => r.brand.is_montra)).slice(0, 1);
  const comps: Standout[] = [];
  for (const r of rank(rows.filter((x) => !x.brand.is_montra))) {
    if (comps.length < 2 && !comps.some((c) => c.brand.id === r.brand.id)) comps.push(r);
  }
  return [...montra, ...comps];
}

// ---------- today's signals ----------

export type Signal = { text: string; alert: boolean; href?: string };

// Up to 3 one-liners from simple rules, alerts first: open comments needing a response, Resonia
// pages that have gone quiet, a post at 3x+ its page average, a competitor posting spike.
export function todaysSignals({
  posts,
  brands,
  comments,
  range,
  today,
  trackingSince,
  showQuiet = true,
  video = [],
}: {
  posts: DashPost[];
  brands: DashBrand[];
  comments: DashComment[];
  range: DateRange;
  today: string;
  trackingSince: string | null;
  showQuiet?: boolean; // "hasn't posted for X days" is for signed-in viewers only
  video?: Signal[]; // video alerts (lib/videoInsights.ts), signed-in viewers only
}): Signal[] {
  const out: Signal[] = [];
  const open = comments.filter(isOpen);
  if (open.length) {
    const oldest = open
      .map((c) => c.posted_at ?? "")
      .filter(Boolean)
      .sort()[0];
    const age = oldest ? rangeDays({ key: "custom", from: istDay(oldest), to: today }) - 1 : null;
    out.push({
      text: `${fmtInt(open.length)} ${open.length === 1 ? "comment or mention needs" : "comments and mentions need"} a response${
        age ? ` (oldest ${age} ${age === 1 ? "day" : "days"} old)` : ""
      }`,
      alert: true,
      href: "/digest",
    });
  }
  // A competitor's video that mentions Resonia, or a negative video that does.
  out.push(...video.slice(0, 2));
  // Days since each Resonia page last posted.
  const quiet = brands
    .filter((b) => b.is_montra)
    .map((b) => {
      const last = posts
        .filter((p) => p.brand === b.id)
        .map((p) => istDay(p.posted_at))
        .sort()
        .at(-1);
      return { b, days: last ? rangeDays({ key: "custom", from: last, to: today }) - 1 : null };
    })
    .filter((x) => x.days != null && x.days >= 5)
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0));
  if (quiet.length && showQuiet) {
    const [q, ...rest] = quiet;
    out.push({
      text: `${q.b.name} hasn't posted for ${q.days} days${rest.length ? ` (${rest.length} other Resonia ${rest.length === 1 ? "page" : "pages"} quiet 5+ days)` : ""}`,
      alert: true,
    });
  }
  // A post at 3x+ its page average in the last 7 days of the range.
  const best = standouts(posts, brands, range).sort((a, b) => b.multiple - a.multiple)[0];
  const big = best && best.multiple >= 3;
  if (big)
    out.push({
      text: `${best.brand.name}'s ${fmtDay(istDay(best.post.posted_at))} post got ${best.multiple.toFixed(1)}× its page average (${fmtInt(best.value)} likes + comments)`,
      alert: false,
      href: best.post.url,
    });
  // A competitor posting well above its usual weekly volume.
  const spike = highlights({ posts, brands, followers: [], range, segment: "all", trackingSince }).find(
    (h) => h.kind === "volume" && !h.brand.is_montra,
  );
  if (spike) out.push({ text: spike.text, alert: false });
  if (!quiet.length && out.length < 3) {
    const lastAny = brands
      .filter((b) => b.is_montra)
      .map((b) =>
        posts
          .filter((p) => p.brand === b.id)
          .map((p) => istDay(p.posted_at))
          .sort()
          .at(-1),
      )
      .filter((d): d is string => !!d)
      .sort()[0];
    if (lastAny) out.push({ text: `Every Resonia page has posted since ${fmtDay(lastAny)}`, alert: false });
  }
  if (ORM_ENABLED && !open.length && out.length < 3)
    out.push({ text: "No comments or mentions are waiting for a response", alert: false, href: "/digest" });
  // Otherwise the week's biggest beat over a page average, so there is always something to read.
  if (out.length < 3 && best && !big && best.multiple > 1)
    out.push({
      text: `This week's biggest beat: ${best.brand.name}'s ${fmtDay(istDay(best.post.posted_at))} post, ${best.multiple.toFixed(1)}× its page average (${fmtInt(best.value)} likes + comments)`,
      alert: false,
      href: best.post.url,
    });
  // Further fallbacks so three signals still show: the busiest competitor this week and the
  // leading competitor by share of voice in the period.
  if (out.length < 3) {
    const week: DateRange = { key: "custom", from: shiftDay(range.to, -6), to: range.to };
    const counts = brands
      .filter((b) => !b.is_montra)
      .map((b) => ({ b, n: postsInRange(posts, week).filter((p) => p.brand === b.id).length }))
      .sort((a, b) => b.n - a.n);
    if (counts[0]?.n)
      out.push({
        text: `Most active competitor this week: ${counts[0].b.name} (${counts[0].n} ${counts[0].n === 1 ? "post" : "posts"})`,
        alert: false,
      });
  }
  if (out.length < 3) {
    const lead = sovSlices(posts, brands, range).find((s) => s.kind === "comp");
    if (lead)
      out.push({
        text: `${lead.name} leads share of voice this period (${(lead.share * 100).toFixed(1)}%)`,
        alert: false,
      });
  }
  return out.slice(0, 3);
}
