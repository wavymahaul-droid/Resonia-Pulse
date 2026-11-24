// Trend lines, earned vs owned media, response times and post growth curves. Pure functions over
// data already stored (posts, daily post and follower snapshots, comments, X and LinkedIn
// mentions), safe in the browser. No Apify calls.
import type { DashBrand, DashComment, DashPost, DashXPost, FollowerPoint } from "@/lib/dashboard";
import { LOW_DATA } from "@/lib/insights";
import { inSegment, istDay, type SegmentFilter } from "@/lib/metrics";
import { inRange, rangeDays, shiftDay, type DateRange } from "@/lib/range";

const eng = (p: Pick<DashPost, "likes" | "comments">) => p.likes + p.comments;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const day = (iso: string | null | undefined) => (iso ? istDay(iso) : null);

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The period of equal length just before the range, for "change vs previous period".
export function previousRange(r: DateRange): DateRange {
  const n = rangeDays(r);
  return { key: "custom", from: shiftDay(r.from, -n), to: shiftDay(r.from, -1) };
}

// ---------- weeks ----------

export type Week = { from: string; to: string; partial: boolean };

// 7-day buckets ending on the range's last day, going back to its first day. The earliest bucket
// is cut at the range start (partial) when the range is not a whole number of weeks.
export function weeksOf(r: DateRange): Week[] {
  const out: Week[] = [];
  for (let to = r.to; to >= r.from; to = shiftDay(to, -7)) {
    const from = shiftDay(to, -6);
    out.unshift({ from: from < r.from ? r.from : from, to, partial: from < r.from });
  }
  return out;
}

const inWeek = (d: string | null, w: Week) => !!d && d >= w.from && d <= w.to;

// ---------- trend lines ----------

export type TrendPoint = { value: number | null; n: number; low: boolean };
export type TrendSeries = {
  id: string;
  name: string;
  montra: boolean;
  followers: TrendPoint[];
  posts: TrendPoint[];
  rate: TrendPoint[];
};

// Week by week, per page: followers at the end of the week (last count by then), posts published
// and the average engagement rate of those posts ((likes + comments) ÷ followers). Plus the
// average of Resonia's pages and of the competitors' pages.
export function trends(
  posts: DashPost[],
  brands: DashBrand[],
  followers: FollowerPoint[],
  range: DateRange,
  segment: SegmentFilter = "all",
): { weeks: Week[]; pages: TrendSeries[]; montra: TrendSeries; comp: TrendSeries } {
  const weeks = weeksOf(range);
  const pages = brands
    .filter((b) => inSegment(b, segment))
    .map((b): TrendSeries => {
      const series = followers.filter((f) => f.brand === b.id && f.followers > 0);
      const own = posts.filter((p) => p.brand === b.id);
      const fol = weeks.map((w): TrendPoint => {
        const f = [...series].reverse().find((x) => x.date <= w.to);
        return { value: f?.followers ?? null, n: f ? 1 : 0, low: false };
      });
      const wk = weeks.map((w) => own.filter((p) => inWeek(day(p.posted_at), w)));
      return {
        id: b.id,
        name: b.name,
        montra: b.is_montra,
        followers: fol,
        posts: wk.map((list) => ({ value: list.length, n: list.length, low: false })),
        // Engagement rate needs a follower count; weeks before the first count use the first one
        // (follower counts move slowly, and daily counts only started with tracking).
        rate: wk.map((list, i) => {
          const f = fol[i].value ?? series[0]?.followers ?? null;
          const v = f ? mean(list.map((p) => eng(p) / f)) : null;
          return { value: v, n: list.length, low: list.length < LOW_DATA };
        }),
      };
    });
  const avg = (id: string, name: string, list: TrendSeries[], montra: boolean): TrendSeries => {
    const pick = (k: "followers" | "posts" | "rate") =>
      weeks.map((_, i): TrendPoint => {
        const pts = list.map((s) => s[k][i]).filter((p) => p.value != null);
        const n = k === "followers" ? pts.length : pts.reduce((a, p) => a + p.n, 0);
        // Engagement rate: the average over all the side's posts that week, not of page averages.
        const value =
          k === "rate"
            ? pts.length
              ? pts.reduce((a, p) => a + (p.value as number) * p.n, 0) / Math.max(1, n)
              : null
            : mean(pts.map((p) => p.value as number));
        return { value, n, low: k === "rate" ? n < LOW_DATA : false };
      });
    return { id, name, montra, followers: pick("followers"), posts: pick("posts"), rate: pick("rate") };
  };
  return {
    weeks,
    pages,
    montra: avg(
      "montra",
      "Resonia average",
      pages.filter((s) => s.montra),
      true,
    ),
    comp: avg(
      "comp",
      "Competitor average",
      pages.filter((s) => !s.montra),
      false,
    ),
  };
}

// ---------- earned vs owned ----------

// Media and brand pages mentioning Resonia (LinkedIn mentions and X media mentions).
export function isEarned(c: DashComment): boolean {
  return !!c.media && !c.page_reply && (c.channel === "li_mention" || c.channel === "x");
}

export type EarnedWeek = Week & { liMedia: number; xMedia: number; liPosts: number; xPosts: number };

export function earnedOwned(
  comments: DashComment[],
  posts: DashPost[], // LinkedIn posts; Resonia pages are picked out here
  xPosts: DashXPost[],
  brands: DashBrand[],
  range: DateRange,
  segment: SegmentFilter = "all",
): { weeks: EarnedWeek[]; total: Omit<EarnedWeek, keyof Week> } {
  const montraIds = new Set(brands.filter((b) => b.is_montra && inSegment(b, segment)).map((b) => b.id));
  const earned = comments.filter(isEarned);
  const own = posts.filter((p) => montraIds.has(p.brand));
  const weeks = weeksOf(range).map((w) => ({
    ...w,
    liMedia: earned.filter((c) => c.channel === "li_mention" && inWeek(day(c.posted_at), w)).length,
    xMedia: earned.filter((c) => c.channel === "x" && inWeek(day(c.posted_at), w)).length,
    liPosts: own.filter((p) => inWeek(day(p.posted_at), w)).length,
    xPosts: xPosts.filter((p) => inWeek(day(p.posted_at), w)).length,
  }));
  const sum = (k: "liMedia" | "xMedia" | "liPosts" | "xPosts") => weeks.reduce((a, w) => a + w[k], 0);
  return {
    weeks,
    total: { liMedia: sum("liMedia"), xMedia: sum("xMedia"), liPosts: sum("liPosts"), xPosts: sum("xPosts") },
  };
}

export type Outlet = { name: string; channel: "LinkedIn" | "X"; count: number; last: string; url: string | null };

// Which media and brand pages mentioned Resonia in the range, most frequent first.
export function mediaOutlets(comments: DashComment[], range: DateRange): Outlet[] {
  const by = new Map<string, Outlet>();
  for (const c of comments) {
    if (!isEarned(c) || !inRange(day(c.posted_at), range)) continue;
    const channel = c.channel === "x" ? "X" : "LinkedIn";
    const key = `${channel}:${c.name.toLowerCase()}`;
    const o = by.get(key) ?? { name: c.name, channel, count: 0, last: "", url: null };
    o.count += 1;
    if ((c.posted_at ?? "") > o.last) {
      o.last = c.posted_at ?? "";
      o.url = c.url;
    }
    by.set(key, o);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || b.last.localeCompare(a.last));
}

// ---------- response time ----------

export type Waiting = { item: DashComment; replyAt: string | null; hours: number | null };
export type ResponseStats = {
  items: Waiting[]; // everything that needed a response, posted in the range
  answered: Waiting[];
  avgHours: number | null;
  medianHours: number | null;
  slowest: Waiting[]; // the 3 slowest answered
  over24: number; // no Resonia reply, not marked handled, older than 24 hours
  over48: number;
  handledNoReply: number; // marked handled by the team without a public reply
  low: boolean;
};

// Resonia LinkedIn comments and X customer tweets that need a response: time from the comment to
// Resonia's first reply under it.
export function responseTimes(comments: DashComment[], range: DateRange, now: string): ResponseStats {
  const firstReply = new Map<string, string>();
  for (const c of comments) {
    if (!c.page_reply || !c.parent || !c.posted_at) continue;
    const prev = firstReply.get(c.parent);
    if (!prev || c.posted_at < prev) firstReply.set(c.parent, c.posted_at);
  }
  const items: Waiting[] = comments
    .filter(
      (c) =>
        c.needs_response &&
        !c.page_reply &&
        c.channel !== "li_mention" &&
        !(c.channel === "x" && c.media) &&
        c.posted_at &&
        inRange(day(c.posted_at), range),
    )
    .map((item) => {
      const replyAt = firstReply.get(item.id) ?? null;
      const hours = replyAt ? Math.max(0, (Date.parse(replyAt) - Date.parse(item.posted_at!)) / 3_600_000) : null;
      return { item, replyAt, hours };
    });
  const answered = items.filter((w) => w.hours != null);
  const hrs = answered.map((w) => w.hours as number);
  const waitingFor = (w: Waiting) => (Date.parse(now) - Date.parse(w.item.posted_at!)) / 3_600_000;
  const open = items.filter((w) => w.hours == null && !w.item.handled);
  return {
    items,
    answered,
    avgHours: mean(hrs),
    medianHours: median(hrs),
    slowest: [...answered].sort((a, b) => (b.hours as number) - (a.hours as number)).slice(0, 3),
    over24: open.filter((w) => waitingFor(w) >= 24).length,
    over48: open.filter((w) => waitingFor(w) >= 48).length,
    handledNoReply: items.filter((w) => w.hours == null && w.item.handled).length,
    low: answered.length < LOW_DATA,
  };
}

export function fmtHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

// ---------- post growth curves ----------

export const CURVE_DAYS = 7;

// A post's likes + comments on each day after it went out (index 0 = the day it was posted,
// IST), from the daily snapshots. Days without a snapshot are null. Built on the server.
export function growthCurve(
  postedAt: string,
  snaps: { date: string; likes: number; comments: number }[],
): (number | null)[] {
  const d0 = istDay(postedAt);
  const by = new Map(snaps.map((s) => [s.date, s.likes + s.comments]));
  return Array.from({ length: CURVE_DAYS + 1 }, (_, i) => by.get(shiftDay(d0, i)) ?? null);
}

export type CurveSide = {
  points: { day: number; avg: number | null; n: number; low: boolean }[]; // days 1, 3 and 7
  share: { day: number; share: number | null; n: number }[]; // share of day-7 engagement, days 0-7
  eightyDay: number | null; // first day a typical post has 80% of its day-7 engagement
  n7: number; // posts with day-1 and day-7 snapshots
};

export function growthStats(posts: DashPost[], brands: DashBrand[]): { montra: CurveSide; comp: CurveSide } {
  const montraIds = new Set(brands.filter((b) => b.is_montra).map((b) => b.id));
  const side = (list: DashPost[]): CurveSide => {
    const curves = list.map((p) => p.growth ?? []).filter((c) => c.some((v) => v != null));
    const points = [1, 3, 7].map((d) => {
      const vals = curves.map((c) => c[d]).filter((v): v is number => v != null);
      return { day: d, avg: mean(vals), n: vals.length, low: vals.length < LOW_DATA };
    });
    // Only posts counted on day 1 and day 7, so a curve that starts late (a post already a week
    // old when tracking began) cannot make its first known day look like the 80% point.
    const full = curves.filter((c) => c[1] != null && c[CURVE_DAYS] != null && (c[CURVE_DAYS] as number) > 0);
    const share = Array.from({ length: CURVE_DAYS + 1 }, (_, d) => {
      const vals = full.map((c) => c[d]).map((v, i) => (v == null ? null : v / (full[i][CURVE_DAYS] as number)));
      const ok = vals.filter((v): v is number => v != null);
      return { day: d, share: mean(ok), n: ok.length };
    });
    const eighty = share.find((s) => s.share != null && s.share >= 0.8);
    return { points, share, eightyDay: full.length ? (eighty?.day ?? CURVE_DAYS) : null, n7: full.length };
  };
  return {
    montra: side(posts.filter((p) => montraIds.has(p.brand))),
    comp: side(posts.filter((p) => !montraIds.has(p.brand))),
  };
}

// ---------- shared ----------

export const change = (now: number | null, prev: number | null): number | null =>
  now == null || prev == null || prev === 0 ? null : (now - prev) / prev;
