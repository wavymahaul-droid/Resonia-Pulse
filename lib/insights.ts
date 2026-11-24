// Insights tab and Overview highlights. Pure functions over posts and follower counts already
// stored, so filters respond instantly in the browser. No Apify calls.
import config from "@/highlights.json";
import type { DashBrand, DashPost, FollowerPoint } from "@/lib/dashboard";
import { LOW_DATA, inSegment, istDay, type SegmentFilter } from "@/lib/metrics";
import { inRange, shiftDay, type DateRange } from "@/lib/range";
import { toPattern } from "@/lib/themes";
import { topRows, type TopPost } from "@/lib/top";

// Any figure based on fewer posts than this is labelled "low data" (defined in lib/metrics).
export { LOW_DATA };

export type Agg = {
  n: number; // posts
  avg: number | null; // average likes + comments per post
  rate: number | null; // average engagement rate: (likes + comments) ÷ page followers
  low: boolean;
  // Most of the posts are known only from a LinkedIn export, which has just their opening text,
  // so a theme or hashtag read from the text may be missing ("partial text").
  partial: boolean;
};

const eng = (p: DashPost) => p.likes + p.comments;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function agg(rows: TopPost[]): Agg {
  return {
    n: rows.length,
    avg: mean(rows.map((r) => eng(r.post))),
    rate: mean(rows.filter((r) => r.rate != null).map((r) => r.rate as number)),
    low: rows.length < LOW_DATA,
    partial: rows.filter((r) => r.post.origin === "export").length * 2 > rows.length,
  };
}

// Posts in the range on the segment's pages, with their engagement rate.
export const insightRows = topRows;

// ---------- best time to post ----------

export const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Day of week (0 = Monday) and hour in IST.
export function istSlot(iso: string): { day: number; hour: number } {
  const d = new Date(Date.parse(iso) + 330 * 60_000);
  return { day: (d.getUTCDay() + 6) % 7, hour: d.getUTCHours() };
}

export type Slot = { day: number; hour: number } & Agg;

// 7 × 24 grid of average likes + comments per post, by IST day and hour of posting.
export function timeGrid(rows: TopPost[]): Slot[][] {
  const cells: TopPost[][][] = DAYS.map(() => Array.from({ length: 24 }, () => []));
  // Posts from a LinkedIn export have a date but no posting time, so they are left out.
  for (const r of rows.filter((x) => x.post.origin !== "export")) {
    const { day, hour } = istSlot(r.post.posted_at);
    cells[day][hour].push(r);
  }
  return cells.map((hours, day) => hours.map((list, hour) => ({ day, hour, ...agg(list) })));
}

// The best slots by average likes + comments. Slots with enough posts come first; low-data slots
// only fill in when there are not enough of those.
export function bestSlots(grid: Slot[][], k = 3): Slot[] {
  return grid
    .flat()
    .filter((s) => s.n > 0)
    .sort((a, b) => Number(a.low) - Number(b.low) || (b.avg ?? 0) - (a.avg ?? 0) || b.n - a.n)
    .slice(0, k);
}

export function fmtSlot(s: { day: number; hour: number }): string {
  const h = (x: number) => `${x % 12 || 12}${x < 12 ? "am" : "pm"}`;
  return `${DAYS[s.day]} ${h(s.hour)}–${h((s.hour + 1) % 24)}`;
}

// ---------- format performance ----------

export const FORMATS = ["Image", "Video", "Document/carousel", "Text"] as const;
export type Format = (typeof FORMATS)[number];

// Carousels are PDF-style documents on LinkedIn, so they sit with documents here; article
// link shares count as text.
export function formatOf(media: string): Format {
  if (media === "image") return "Image";
  if (media === "video") return "Video";
  if (media === "document" || media === "carousel") return "Document/carousel";
  return "Text";
}

export type SidePerf<K extends string> = { key: K; montra: Agg; comp: Agg };

export function formatPerf(rows: TopPost[]): {
  overall: SidePerf<Format>[];
  pages: { brand: DashBrand; byFormat: Map<Format, Agg>; all: Agg }[];
} {
  const of = (list: TopPost[], f: Format) => list.filter((r) => formatOf(r.post.media) === f);
  const montra = rows.filter((r) => r.brand.is_montra);
  const comp = rows.filter((r) => !r.brand.is_montra);
  const brands = [...new Map(rows.map((r) => [r.brand.id, r.brand])).values()];
  return {
    overall: FORMATS.map((f) => ({ key: f, montra: agg(of(montra, f)), comp: agg(of(comp, f)) })),
    pages: brands.map((brand) => {
      const own = rows.filter((r) => r.brand.id === brand.id);
      return { brand, all: agg(own), byFormat: new Map(FORMATS.map((f) => [f, agg(of(own, f))])) };
    }),
  };
}

// ---------- theme performance ----------

// A theme over- or under-performs when its average likes + comments is this far from the
// average of all posts on that side (Resonia or competitors). Never flagged on low data.
export const OVER = 1.25;
export const UNDER = 0.8;
export type Flag = "over" | "under" | null;

export function flagOf(a: Agg, base: Agg): Flag {
  if (a.low || base.low || a.avg == null || !base.avg) return null;
  const ratio = a.avg / base.avg;
  return ratio >= OVER ? "over" : ratio <= UNDER ? "under" : null;
}

export function themePerf(
  rows: TopPost[],
  themes: string[],
): { themes: (SidePerf<string> & { montraFlag: Flag; compFlag: Flag })[]; montra: Agg; comp: Agg } {
  const montraRows = rows.filter((r) => r.brand.is_montra);
  const compRows = rows.filter((r) => !r.brand.is_montra);
  const montra = agg(montraRows);
  const comp = agg(compRows);
  const used = themes.filter((t) => rows.some((r) => r.post.theme === t));
  return {
    montra,
    comp,
    themes: used.map((t) => {
      const m = agg(montraRows.filter((r) => r.post.theme === t));
      const c = agg(compRows.filter((r) => r.post.theme === t));
      return { key: t, montra: m, comp: c, montraFlag: flagOf(m, montra), compFlag: flagOf(c, comp) };
    }),
  };
}

// ---------- hashtags ----------

// Hashtags in a post, lower-cased and once each. LinkedIn sometimes exports them as "hashtag#EV".
export function hashtags(text: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of (text ?? "")
    .normalize("NFKC")
    .replace(/hashtag#/gi, " #")
    .matchAll(/(?<![\p{L}\p{N}_&])#([\p{L}\p{N}_]*[\p{L}][\p{L}\p{N}_]*)/gu)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

export type TagStat = { tag: string; uses: number; pages: number } & Agg;

export function hashtagStats(rows: TopPost[]): { overall: TagStat[]; perPage: Map<string, TagStat[]> } {
  const build = (list: TopPost[]): TagStat[] => {
    const byTag = new Map<string, TopPost[]>();
    for (const r of list) for (const t of hashtags(r.post.text)) byTag.set(t, [...(byTag.get(t) ?? []), r]);
    return [...byTag]
      .map(([tag, posts]) => ({
        tag,
        uses: posts.length,
        pages: new Set(posts.map((r) => r.brand.id)).size,
        ...agg(posts),
      }))
      .sort((a, b) => b.uses - a.uses || (b.avg ?? 0) - (a.avg ?? 0) || a.tag.localeCompare(b.tag));
  };
  const perPage = new Map<string, TagStat[]>();
  for (const id of new Set(rows.map((r) => r.brand.id))) {
    perPage.set(id, build(rows.filter((r) => r.brand.id === id)));
  }
  return { overall: build(rows), perPage };
}

// ---------- highlights ----------

export type HighlightKind = "volume" | "spike" | "launch" | "followers";
export type Highlight = {
  kind: HighlightKind;
  brand: DashBrand;
  date: string; // IST day, for sorting
  text: string;
  url?: string;
};

const LAUNCH = config.launchKeywords.map((k) => ({ keyword: k.replace(/\*$/, ""), re: toPattern(k) }));

export function launchKeywords(text: string | null | undefined): string[] {
  const t = (text ?? "").normalize("NFKC");
  const hits = LAUNCH.filter((k) => k.re.test(t)).map((k) => k.keyword);
  // "bookings" adds nothing when "bookings open" matched too.
  return hits.filter((k) => !hits.some((o) => o !== k && o.startsWith(`${k} `)));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (d: string) => {
  const [, m, day] = d.split("-").map(Number);
  return `${day} ${MONTHS[m - 1]}`;
};
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

// Automatic callouts for the Overview. `posts` is everything loaded (for each page's usual
// numbers); callouts are about the range and the segment's pages.
export function highlights({
  posts,
  brands,
  followers,
  range,
  segment,
  trackingSince,
  settings = config,
}: {
  posts: DashPost[];
  brands: DashBrand[];
  followers: FollowerPoint[];
  range: DateRange;
  segment: SegmentFilter;
  trackingSince: string | null; // first day of daily syncs; earlier weeks only have each page's latest posts
  settings?: Pick<typeof config, "volumeMultiple" | "postMultiple" | "minLikesComments" | "followerJumpPct">;
}): Highlight[] {
  const out: Highlight[] = [];
  const pages = brands.filter((b) => inSegment(b, segment));
  const byBrand = new Map<string, DashPost[]>();
  for (const p of posts) byBrand.set(p.brand, [...(byBrand.get(p.brand) ?? []), p]);
  for (const brand of pages) {
    const own = byBrand.get(brand.id) ?? [];
    const name = brand.name;

    // 1. Posting volume: the last 7 days of the range against the weekly average of the 4 weeks
    // before, counting only days with daily syncs.
    const weekFrom = shiftDay(range.to, -6);
    const week = own.filter((p) => inRange(istDay(p.posted_at), { key: "custom", from: weekFrom, to: range.to }));
    const baseTo = shiftDay(weekFrom, -1);
    let baseFrom = shiftDay(weekFrom, -28);
    if (trackingSince && istDay(trackingSince) > baseFrom) baseFrom = istDay(trackingSince);
    const baseDays = baseFrom <= baseTo ? Math.round((Date.parse(baseTo) - Date.parse(baseFrom)) / 86_400_000) + 1 : 0;
    if (baseDays >= 7 && week.length >= 3) {
      const base = own.filter((p) => inRange(istDay(p.posted_at), { key: "custom", from: baseFrom, to: baseTo }));
      const usual = base.length / (baseDays / 7);
      if (week.length >= settings.volumeMultiple * usual) {
        out.push({
          kind: "volume",
          brand,
          date: range.to,
          text: `${name} posted ${week.length} times in the 7 days to ${fmtDay(range.to)}, ${
            usual ? `${(week.length / usual).toFixed(1)}× its usual ${usual.toFixed(1)} a week` : "usually none"
          }${base.length < LOW_DATA ? " (low data)" : ""}`,
        });
      }
    }

    // 2. A post far above its page's average likes + comments (needs 5+ posts for the average).
    if (own.length >= LOW_DATA) {
      const avg = own.reduce((a, p) => a + eng(p), 0) / own.length;
      for (const p of own) {
        if (!inRange(istDay(p.posted_at), range)) continue;
        const e = eng(p);
        if (avg > 0 && e >= settings.minLikesComments && e >= settings.postMultiple * avg) {
          out.push({
            kind: "spike",
            brand,
            date: istDay(p.posted_at),
            url: p.url,
            text: `${name}: a post on ${fmtDay(istDay(p.posted_at))} got ${e} likes + comments, ${(e / avg).toFixed(1)}× the page's average of ${avg.toFixed(0)}: "${clip(p.text, 90)}"`,
          });
        }
      }
    }

    // 3. Competitor posts with launch keywords.
    if (!brand.is_montra) {
      for (const p of own) {
        if (!inRange(istDay(p.posted_at), range)) continue;
        const hits = launchKeywords(p.text);
        if (hits.length) {
          out.push({
            kind: "launch",
            brand,
            date: istDay(p.posted_at),
            url: p.url,
            text: `${name} (${fmtDay(istDay(p.posted_at))}, “${hits.join("”, “")}”): "${clip(p.text, 110)}"`,
          });
        }
      }
    }

    // 4. Followers up 1%+ in a week: the last count in the range against the last one a week before it.
    const series = followers.filter((x) => x.brand === brand.id && x.followers > 0 && x.date <= range.to);
    const last = series.at(-1);
    if (last && last.date >= range.from) {
      const base = [...series].reverse().find((x) => x.date <= shiftDay(last.date, -7));
      if (base) {
        const gain = (last.followers - base.followers) / base.followers;
        if (gain * 100 >= settings.followerJumpPct) {
          out.push({
            kind: "followers",
            brand,
            date: last.date,
            text: `${name} gained ${(last.followers - base.followers).toLocaleString("en-IN")} followers (${pct(gain)}) in the week to ${fmtDay(last.date)}`,
          });
        }
      }
    }
  }
  const order: Record<HighlightKind, number> = { launch: 0, spike: 1, volume: 2, followers: 3 };
  return out.sort((a, b) => b.date.localeCompare(a.date) || order[a.kind] - order[b.kind]);
}
