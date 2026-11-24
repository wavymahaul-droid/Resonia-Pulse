// New followers per Resonia page from the uploaded LinkedIn Followers exports (organic, sponsored and
// total, LinkedIn's own daily figures), and the fallback for the follower KPIs when the scraped
// follower counts have no value for a period. Pure, safe in the browser. Page-level figures, so they
// are shown in the public view too.
import type { FollowerPoint, LiPageDay } from "@/lib/dashboard";
import type { Kpis } from "@/lib/metrics";
import { inRange, rangeDays, shiftDay, type DateRange } from "@/lib/range";

export type FollowerSplit = {
  organic: number | null;
  sponsored: number | null;
  total: number | null; // LinkedIn's total (includes auto-invited followers, if any)
  days: number; // days of the range in the uploaded Followers exports
  of: number; // days in the range
};

const sum = (rows: LiPageDay[], k: keyof LiPageDay) => {
  const v = rows.map((r) => r[k]).filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) : null;
};

// One page's new followers over a range.
export function newFollowers(days: LiPageDay[], brand: string, range: DateRange): FollowerSplit {
  const rows = days.filter((d) => d.brand === brand && inRange(d.date, range) && d.new_followers != null);
  return {
    organic: sum(rows, "new_followers_organic"),
    sponsored: sum(rows, "new_followers_sponsored"),
    total: sum(rows, "new_followers"),
    days: new Set(rows.map((r) => r.date)).size,
    of: rangeDays(range),
  };
}

export type FollowerKpis = Kpis & {
  followersNote?: string; // where a fallback "Resonia followers" came from
  growthNote?: string; // where a fallback "Resonia follower growth" came from
};

const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

// The follower KPIs fall back to the exports when the scraped counts have no value:
// - growth: LinkedIn's new followers (total) on the Resonia pages over the range;
// - followers: each page's next scraped count after the range minus the export's new followers
//   in between (an estimate; LinkedIn's new followers leave out unfollows), or, when the exports
//   do not cover those days, the next scraped count itself with its date.
export function withExportFollowers(
  k: Kpis,
  {
    days,
    followers,
    range,
    montraIds,
  }: { days: LiPageDay[]; followers: FollowerPoint[]; range: DateRange; montraIds: string[] },
): FollowerKpis {
  const out: FollowerKpis = { ...k };
  if (out.montraGrowth == null && montraIds.length) {
    const splits = montraIds.map((id) => newFollowers(days, id, range));
    const withData = splits.filter((s) => s.total != null);
    if (withData.length) {
      out.montraGrowth = withData.reduce((a, s) => a + (s.total as number), 0);
      const short = splits.filter((s) => s.days < s.of).length;
      out.growthNote = `LinkedIn new followers (export)${short ? `; ${short} of ${splits.length} pages miss some days` : ""}`;
    }
  }
  if (out.montraFollowers == null && montraIds.length) {
    let total = 0;
    let found = 0;
    let estimated = 0;
    const asOf = new Set<string>();
    for (const id of montraIds) {
      const next = followers
        .filter((f) => f.brand === id && f.followers > 0 && f.date > range.to)
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      if (!next) continue;
      found++;
      // Followers gained after the range, up to the day of that count.
      const gap: DateRange = { key: "custom", from: shiftDay(range.to, 1), to: next.date };
      const g = newFollowers(days, id, gap);
      if (g.total != null && g.days === g.of) {
        total += next.followers - g.total;
        estimated++;
      } else {
        total += next.followers;
        asOf.add(next.date);
      }
    }
    if (found) {
      out.montraFollowers = total;
      out.followersNote = asOf.size
        ? `count on ${[...asOf].sort().map(fmtDay).join(", ")} (first count after this period)`
        : "estimated: next count minus LinkedIn new followers (export)";
      if (estimated && asOf.size) out.followersNote = `partly estimated from the export; ${out.followersNote}`;
    }
  }
  if (out.montraGrowth != null && out.montraFollowers && (k.montraGrowth == null || k.montraFollowers == null))
    out.montraGrowthPct = out.montraGrowth / (out.montraFollowers - out.montraGrowth);
  return out;
}

// ---------- per page ----------

export type PageFollowers = {
  value: number | null;
  asOf?: string; // a count from after the date (no count by then)
  estimated?: boolean; // next count minus the export's new followers in between
};

// A page's follower count on a date: its last scraped count by then; else (counts started later)
// its first count after, minus the export's new followers in between when the exports cover those
// days in full (an estimate), or that count itself with its date.
export function pageFollowersAt(
  followers: FollowerPoint[],
  days: LiPageDay[],
  brand: string,
  to: string,
): PageFollowers {
  const own = followers
    .filter((f) => f.brand === brand && f.followers > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const before = own.filter((f) => f.date <= to).at(-1);
  if (before) return { value: before.followers };
  const next = own.find((f) => f.date > to);
  if (!next) return { value: null };
  const g = newFollowers(days, brand, { key: "custom", from: shiftDay(to, 1), to: next.date });
  return g.total != null && g.days === g.of
    ? { value: next.followers - g.total, estimated: true }
    : { value: next.followers, asOf: next.date };
}

export type RowNote = { followers?: string; growth?: string };

// Leaderboard rows with the follower fallbacks filled in where the scraped counts have no value:
// followers as above (any page), growth from the export's new followers (Resonia pages with
// Followers exports for the period). Engagement rates are recomputed with the fallback count.
export function withFollowerFallback<
  S extends {
    brand: { id: string; is_montra: boolean };
    followers: number | null;
    growth: number | null;
    growthPct: number | null;
    posts: number;
    avgLikes: number | null;
    avgComments: number | null;
    engagementRate: number | null;
  },
>(stats: S[], { followers, days, range }: { followers: FollowerPoint[]; days: LiPageDay[]; range: DateRange }) {
  const notes = new Map<string, RowNote>();
  const rows = stats.map((s) => {
    const out = { ...s };
    const note: RowNote = {};
    if (out.followers == null) {
      const f = pageFollowersAt(followers, days, s.brand.id, range.to);
      if (f.value != null) {
        out.followers = f.value;
        note.followers = f.estimated
          ? "Estimated: next count minus LinkedIn new followers (export)"
          : `Count on ${fmtDay(f.asOf!)} (first count after this period)`;
        if (out.engagementRate == null && s.posts)
          out.engagementRate = ((s.avgLikes ?? 0) + (s.avgComments ?? 0)) / f.value;
      }
    }
    if (out.growth == null && s.brand.is_montra) {
      const nf = newFollowers(days, s.brand.id, range);
      if (nf.total != null) {
        out.growth = nf.total;
        out.growthPct = out.followers ? nf.total / (out.followers - nf.total) : null;
        note.growth = `LinkedIn new followers (export)${nf.days < nf.of ? `, ${nf.days} of ${nf.of} days` : ""}`;
      }
    }
    if (note.followers || note.growth) notes.set(s.brand.id, note);
    return out;
  });
  return { rows, notes };
}
