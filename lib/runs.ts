// Run kinds and per-step search windows.
// The evening run (17:00 IST) does everything; the morning (07:00 IST) and afternoon (13:00 IST)
// scans only run the X step and the LinkedIn mention search. Each search starts where the last
// successful run of that step started, minus a 1-hour overlap, so posts are not paid for twice.
import type { SupabaseClient } from "@supabase/supabase-js";

export type RunKind = "morning" | "afternoon" | "evening";
export const RUN_KINDS: RunKind[] = ["morning", "afternoon", "evening"];
export const RUN_LABEL: Record<RunKind, string> = { morning: "Morning", afternoon: "Afternoon", evening: "Evening" };

export const OVERLAP_MS = 3_600_000;

// Start of the next search: the last successful run of the step minus the overlap, but never
// further back than maxMs. With no successful run yet, firstMs back from now.
export function windowStart(lastSuccess: string | null, now: Date, firstMs: number, maxMs: number): Date {
  if (!lastSuccess) return new Date(now.getTime() - firstMs);
  return new Date(Math.max(now.getTime() - maxMs, Date.parse(lastSuccess) - OVERLAP_MS));
}

// When the last successful run of a step started (sync_runs.x_status / mentions_status).
// Null before supabase/schema.sql adds those columns, or when the step never succeeded.
export async function lastStepSuccess(db: SupabaseClient, step: "x" | "mentions"): Promise<string | null> {
  const { data, error } = await db
    .from("sync_runs")
    .select("started_at")
    .eq(`${step}_status`, "success")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) return null;
  return (data?.[0]?.started_at as string | undefined) ?? null;
}

// Start of today in IST, as an ISO timestamp.
export function istMidnight(now = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
  return new Date(`${day}T00:00:00+05:30`).toISOString();
}

// True once supabase/schema.sql has added sync_runs.kind and the per-step status columns.
export async function runColumnsReady(db: SupabaseClient): Promise<boolean> {
  return !(await db.from("sync_runs").select("kind,x_status,mentions_status,mentions_fetched").limit(1)).error;
}

// A plain-language reason for a run that did not fully succeed, for the dashboard tooltip, read from
// the run's notes. Page ids are shown by name.
export function runReason(
  status: string | null | undefined,
  notes: string | null | undefined,
  names: Map<string, string>,
): string | null {
  if (!status || status === "success" || !notes) return null;
  const pages = (list: string) =>
    list
      .split(",")
      .map((s) => names.get(s.trim()) ?? s.trim())
      .join(", ");
  const reasons: string[] = [];
  if (/Posts step failed/.test(notes)) reasons.push("Posts step failed after a retry; posts catch up next run");
  const none = notes.match(/No posts returned for: ([^.]+)/);
  if (none) reasons.push(`No posts returned for ${pages(none[1])} (retried once); catches up next run`);
  if (/Comments failed/.test(notes)) reasons.push("Comments step failed; catches up next run");
  if (/(^|\. )X failed/.test(notes)) reasons.push("X step failed; catches up next run");
  if (/LinkedIn mentions failed/.test(notes)) reasons.push("LinkedIn mentions step failed; catches up next run");
  for (const m of notes.matchAll(/(Posts|Comments|X|LinkedIn mentions): (\d+) items? skipped/g)) {
    reasons.push(
      `${m[1]}: ${m[2]} item${m[2] === "1" ? "" : "s"} could not be saved and ${m[2] === "1" ? "was" : "were"} skipped (see Sync health)`,
    );
  }
  if (/Skipped: Apify usage/.test(notes)) reasons.push("Skipped: the monthly Apify budget is used up");
  if (/schema is out of date/i.test(notes)) reasons.push("Database schema is out of date: re-run supabase/schema.sql");
  return reasons.length ? reasons.join(". ") : null;
}
