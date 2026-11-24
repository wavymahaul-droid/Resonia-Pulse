// Date ranges shared by every view (Overview, Comments, X and the ORM digest). A range is a pair
// of IST calendar days, both included, plus the quick option that produced it. It travels in the
// page link (?range=7d, or ?range=custom&from=2026-10-01&to=2026-10-06) so a shared link opens the
// same period. Safe in the browser.

export type RangeKey = "today" | "yesterday" | "7d" | "30d" | "90d" | "180d" | "thisMonth" | "lastMonth" | "custom";
export type DateRange = { key: RangeKey; from: string; to: string }; // YYYY-MM-DD, IST, inclusive

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "180d", label: "Last 6 months" },
  { key: "thisMonth", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "custom", label: "Custom" },
];
const KEYS = new Set(RANGE_OPTIONS.map((o) => o.key));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function istToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

// The range a quick option stands for on `today`. Last N days includes today.
export function presetRange(key: Exclude<RangeKey, "custom">, today: string): DateRange {
  const [y, m] = today.split("-").map(Number);
  const monthStart = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  switch (key) {
    case "today":
      return { key, from: today, to: today };
    case "yesterday":
      return { key, from: shiftDay(today, -1), to: shiftDay(today, -1) };
    case "7d":
      return { key, from: shiftDay(today, -6), to: today };
    case "30d":
      return { key, from: shiftDay(today, -29), to: today };
    case "90d":
      return { key, from: shiftDay(today, -89), to: today };
    case "180d":
      return { key, from: shiftDay(today, -182), to: today };
    case "thisMonth":
      return { key, from: monthStart(y, m), to: today };
    case "lastMonth": {
      const [py, pm] = m === 1 ? [y - 1, 12] : [y, m - 1];
      return { key, from: monthStart(py, pm), to: shiftDay(monthStart(y, m), -1) };
    }
  }
}

export function customRange(from: string, to: string, today: string): DateRange {
  let [a, b] = [from, to].map((d) => (d > today ? today : d));
  if (a > b) [a, b] = [b, a];
  return { key: "custom", from: a, to: b };
}

// From the page link; falls back to `fallback` when the link has no (valid) range.
export function rangeFromParams(
  params: { range?: string | null; from?: string | null; to?: string | null; date?: string | null },
  today: string,
  fallback: Exclude<RangeKey, "custom">,
): DateRange {
  const key = params.range as RangeKey | undefined;
  if (key === "custom" || (!key && params.from && params.to)) {
    if (DAY_RE.test(params.from ?? "") && DAY_RE.test(params.to ?? ""))
      return customRange(params.from!, params.to!, today);
  }
  if (key && key !== "custom" && KEYS.has(key)) return presetRange(key, today);
  // Older digest links: ?date=YYYY-MM-DD
  if (DAY_RE.test(params.date ?? "")) return customRange(params.date!, params.date!, today);
  return presetRange(fallback, today);
}

export function rangeQuery(r: DateRange): string {
  return r.key === "custom" ? `range=custom&from=${r.from}&to=${r.to}` : `range=${r.key}`;
}

export function rangeDays(r: DateRange): number {
  return Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function inRange(day: string | null | undefined, r: DateRange): boolean {
  return !!day && day >= r.from && day <= r.to;
}

// The same length of time just before (←) or after (→), as a custom range.
export function stepRange(r: DateRange, dir: -1 | 1, today: string): DateRange {
  const n = rangeDays(r) * dir;
  return customRange(shiftDay(r.from, n), shiftDay(r.to, n), today);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const parts = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return { y, m: MONTHS[m - 1], d: day };
};

// "6 Oct 2026", "1–6 Oct 2026", "28 Sep – 6 Oct 2026", "30 Dec 2025 – 2 Jan 2026"
export function fmtRange(r: Pick<DateRange, "from" | "to">): string {
  const a = parts(r.from);
  const b = parts(r.to);
  if (r.from === r.to) return `${b.d} ${b.m} ${b.y}`;
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${b.m} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${a.m} – ${b.d} ${b.m} ${b.y}`;
  return `${a.d} ${a.m} ${a.y} – ${b.d} ${b.m} ${b.y}`;
}

// Short phrase for sub-titles: "last 30 days", "today", "this month", or the dates.
export function rangePhrase(r: DateRange): string {
  switch (r.key) {
    case "today":
      return "today";
    case "yesterday":
      return "yesterday";
    case "7d":
      return "last 7 days";
    case "30d":
      return "last 30 days";
    case "90d":
      return "last 90 days";
    case "180d":
      return "last 6 months";
    case "thisMonth":
      return "this month";
    case "lastMonth":
      return "last month";
    default:
      return fmtRange(r);
  }
}

// How far back the server must load data to cover the range (with a week before it, for
// follower growth), and never less than the usual 91 days.
export function loadSince(r: DateRange, now = new Date()): string {
  const usual = new Date(now.getTime() - 91 * 86_400_000);
  const start = new Date(`${shiftDay(r.from, -7)}T00:00:00+05:30`);
  return (start < usual ? start : usual).toISOString();
}
