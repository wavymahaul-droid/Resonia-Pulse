// Day-by-day new followers per Resonia page, for the Followers section of the Overview. Pure, safe
// in the browser. Page-level figures only, so the public view shows them too.
//
// Where each day's number comes from:
//   1. the uploaded LinkedIn Followers export (LinkedIn's own "new followers" for that day), else
//   2. the change in our daily follower count from the day before (an estimate, shown with "~";
//      it is net of unfollows, so it can differ slightly from LinkedIn's number), else
//   3. nothing: the day is a gap. A gap is never shown or counted as zero.
// When counts are missing for a few days in a row, the change across the whole stretch is still
// known (count after minus count before): totals for a week or month include it, while the single
// days inside the stretch stay gaps.
import type { FollowerPoint, LiPageDay } from "@/lib/dashboard";
import { shiftDay } from "@/lib/range";

export type GainSource = "export" | "estimate";
export type DayGain = { date: string; value: number | null; source: GainSource | null };
export type PeriodGain = {
  value: number | null; // null when no day of the period has a number
  estimated: boolean; // true when any part comes from our own counts
  missingDays: number; // days of the period with no number at all
  days: number; // days in the period
};

type Lookup = { exp: Map<string, number>; snap: Map<string, number> };

function lookup(brand: string, days: LiPageDay[], followers: FollowerPoint[]): Lookup {
  const exp = new Map<string, number>();
  for (const d of days) if (d.brand === brand && typeof d.new_followers === "number") exp.set(d.date, d.new_followers);
  const snap = new Map<string, number>();
  for (const f of followers) if (f.brand === brand && f.followers > 0) snap.set(f.date, f.followers);
  return { exp, snap };
}

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d);
  return out;
}

// One page, one number per day from `from` to `to` (both included).
export function dailyGains(
  brand: string,
  days: LiPageDay[],
  followers: FollowerPoint[],
  from: string,
  to: string,
): DayGain[] {
  const { exp, snap } = lookup(brand, days, followers);
  return eachDay(from, to).map((date) => {
    if (exp.has(date)) return { date, value: exp.get(date)!, source: "export" };
    const now = snap.get(date);
    const before = snap.get(shiftDay(date, -1));
    if (now != null && before != null) return { date, value: now - before, source: "estimate" };
    return { date, value: null, source: null };
  });
}

// One page's new followers over a period. Export days count as they are; each stretch of days
// without an export is measured between the first and last of our counts around it.
export function periodGain(
  brand: string,
  days: LiPageDay[],
  followers: FollowerPoint[],
  from: string,
  to: string,
): PeriodGain {
  const { exp, snap } = lookup(brand, days, followers);
  const all = eachDay(from, to);
  let value = 0;
  let covered = 0;
  let estimated = false;
  let i = 0;
  while (i < all.length) {
    if (exp.has(all[i])) {
      value += exp.get(all[i])!;
      covered++;
      i++;
      continue;
    }
    // A stretch of days without an export: all[i..j].
    let j = i;
    while (j + 1 < all.length && !exp.has(all[j + 1])) j++;
    // Our counts from the day before the stretch to its last day.
    const counts = [shiftDay(all[i], -1), ...all.slice(i, j + 1)].filter((d) => snap.has(d));
    if (counts.length >= 2) {
      const first = counts[0];
      const last = counts[counts.length - 1];
      value += snap.get(last)! - snap.get(first)!;
      covered += eachDay(shiftDay(first, 1), last).length;
      estimated = true;
    }
    i = j + 1;
  }
  return { value: covered ? value : null, estimated, missingDays: all.length - covered, days: all.length };
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const daysInMonth = (day: string) => {
  const [y, m] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
// Monday of the week `day` is in.
const weekStart = (day: string) => shiftDay(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));

export type Pace = "on track" | "behind";
export type FollowerRow = {
  id: string; // page id, or "all" for the combined row
  label: string;
  chart: DayGain[]; // every day of the current month up to today
  today: DayGain;
  yesterday: DayGain;
  week: PeriodGain; // Monday to today
  mtd: PeriodGain;
  lastMonthSamePoint: PeriodGain; // 1st of last month to the same day of the month
  projected: number | null; // month-end figure at the current daily average
  total: number | null; // latest follower count
  totalAsOf: string | null;
  target: number | null;
  pace: Pace | null; // only when a target is set and a projection exists
};

export type FollowerPage = { id: string; label: string };

function latestCount(brand: string, followers: FollowerPoint[], today: string) {
  const own = followers
    .filter((f) => f.brand === brand && f.followers > 0 && f.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date))
    .at(-1);
  return own ? { total: own.followers, totalAsOf: own.date } : { total: null, totalAsOf: null };
}

// The month-end figure if the rest of the month runs at the daily average of the days counted so far.
export function projectMonthEnd(mtd: PeriodGain, today: string): number | null {
  const counted = mtd.days - mtd.missingDays;
  if (mtd.value == null || counted <= 0) return null;
  return Math.round((mtd.value / counted) * daysInMonth(today));
}

export function paceFor(projected: number | null, target: number | null | undefined): Pace | null {
  if (!target || target <= 0 || projected == null) return null;
  return projected >= target ? "on track" : "behind";
}

// Adds up pages. A day (or period) is a gap for the group when it is a gap for any page: a total
// that leaves a page out would read as a drop.
function addDays(rows: DayGain[][]): DayGain[] {
  return (rows[0] ?? []).map((d, i) => {
    const parts = rows.map((r) => r[i]);
    if (parts.some((p) => p.value == null)) return { date: d.date, value: null, source: null };
    return {
      date: d.date,
      value: parts.reduce((a, p) => a + (p.value as number), 0),
      source: parts.every((p) => p.source === "export") ? "export" : "estimate",
    };
  });
}
function addPeriods(parts: PeriodGain[]): PeriodGain {
  const days = parts[0]?.days ?? 0;
  if (!parts.length || parts.some((p) => p.value == null))
    return { value: null, estimated: false, missingDays: days, days };
  return {
    value: parts.reduce((a, p) => a + (p.value as number), 0),
    estimated: parts.some((p) => p.estimated),
    missingDays: Math.max(...parts.map((p) => p.missingDays)),
    days,
  };
}

// The Followers section: one row per page, then a combined row.
export function followerRows({
  pages,
  days,
  followers,
  today,
  targets = {},
}: {
  pages: FollowerPage[];
  days: LiPageDay[];
  followers: FollowerPoint[];
  today: string; // IST day
  targets?: Record<string, number | null | undefined>;
}): FollowerRow[] {
  const from = monthStart(today);
  const prevEnd = shiftDay(from, -1);
  const prevFrom = monthStart(prevEnd);
  // The same day of the month, or the last day of a shorter month.
  const dom = Math.min(Number(today.slice(8, 10)), daysInMonth(prevEnd));
  const prevTo = `${prevFrom.slice(0, 8)}${String(dom).padStart(2, "0")}`;

  const rows: FollowerRow[] = pages.map((p) => {
    const chart = dailyGains(p.id, days, followers, from, today);
    const mtd = periodGain(p.id, days, followers, from, today);
    const projected = projectMonthEnd(mtd, today);
    const target = targets[p.id] ?? null;
    return {
      id: p.id,
      label: p.label,
      chart,
      today: chart[chart.length - 1],
      yesterday: dailyGains(p.id, days, followers, shiftDay(today, -1), shiftDay(today, -1))[0],
      week: periodGain(p.id, days, followers, weekStart(today), today),
      mtd,
      lastMonthSamePoint: periodGain(p.id, days, followers, prevFrom, prevTo),
      projected,
      ...latestCount(p.id, followers, today),
      target,
      pace: paceFor(projected, target),
    };
  });
  if (rows.length < 2) return rows;

  const mtd = addPeriods(rows.map((r) => r.mtd));
  const projected = projectMonthEnd(mtd, today);
  const allTargets = rows.every((r) => r.target && r.target > 0);
  const target = allTargets ? rows.reduce((a, r) => a + (r.target as number), 0) : (targets.all ?? null);
  const counted = rows.filter((r) => r.total != null);
  const asOf = counted.map((r) => r.totalAsOf as string).sort();
  rows.push({
    id: "all",
    label: "All 4 pages".replace("4", String(rows.length)),
    chart: addDays(rows.map((r) => r.chart)),
    today: addDays(rows.map((r) => [r.today]))[0],
    yesterday: addDays(rows.map((r) => [r.yesterday]))[0],
    week: addPeriods(rows.map((r) => r.week)),
    mtd,
    lastMonthSamePoint: addPeriods(rows.map((r) => r.lastMonthSamePoint)),
    projected,
    total: counted.length === rows.length ? counted.reduce((a, r) => a + (r.total as number), 0) : null,
    totalAsOf: counted.length === rows.length ? asOf[0] : null, // the oldest of the counts added up
    target,
    pace: paceFor(projected, target),
  });
  return rows;
}
