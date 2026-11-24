// "Sync health (7 days)" on the dashboard (signed in): each run with its status, the step that
// failed, and rows saved vs skipped per step, so a one-off fault can be told from a recurring one.
// Runs from before sync_runs.step_stats existed are read from their other columns and notes
// (skipped counts are then unknown). Pure; safe in the browser.

export const HEALTH_STEPS = ["posts", "comments", "x", "mentions"] as const;
export type HealthStep = (typeof HEALTH_STEPS)[number];
export const STEP_LABEL: Record<HealthStep, string> = {
  posts: "Posts",
  comments: "Comments",
  x: "X",
  mentions: "LinkedIn mentions",
};

export type StepCell = {
  status: "ok" | "partial" | "failed" | "skipped";
  saved: number | null;
  skipped: number | null; // null: not recorded (runs before step_stats)
  error?: string;
};

export type HealthRunRow = {
  id: number;
  kind?: string | null;
  started_at: string;
  status: string;
  notes: string | null;
  pages_failed?: string[] | null;
  posts_saved?: number | null;
  comments_saved?: number | null;
  x_saved?: number | null;
  mentions_saved?: number | null;
  x_status?: string | null;
  mentions_status?: string | null;
  step_stats?: Partial<Record<HealthStep, StepCell>> | null;
};

export type HealthRun = {
  id: number;
  kind: string;
  started_at: string;
  status: string;
  failing: HealthStep[]; // steps that failed or skipped more than a fifth of their rows
  steps: Partial<Record<HealthStep, StepCell>>; // only the steps this kind of run has
};

export type SkippedItem = {
  at: string;
  run_id: number | null;
  step: string | null;
  table_name: string;
  source_id: string;
  error: string | null;
  strikes: number;
  permanent: boolean;
};

const fromStatus = (s: string | null | undefined): StepCell["status"] =>
  s === "failed" ? "failed" : s === "skipped" || s == null ? "skipped" : "ok";

// A run's steps, from step_stats or (older runs) from the other columns.
export function healthSteps(r: HealthRunRow): Partial<Record<HealthStep, StepCell>> {
  const kind = r.kind ?? "evening";
  if (r.step_stats) {
    const out: Partial<Record<HealthStep, StepCell>> = {};
    for (const k of HEALTH_STEPS) if (r.step_stats[k]) out[k] = r.step_stats[k];
    return out;
  }
  const notes = r.notes ?? "";
  const steps: Partial<Record<HealthStep, StepCell>> = {};
  if (kind === "evening") {
    steps.posts = {
      status: /Posts step failed/.test(notes)
        ? "failed"
        : r.pages_failed?.length
          ? "partial"
          : /No pages due/.test(notes)
            ? "skipped"
            : "ok",
      saved: r.posts_saved ?? null,
      skipped: null,
    };
    steps.comments = {
      status: /Comments failed/.test(notes) ? "failed" : /Comments skipped/.test(notes) ? "skipped" : "ok",
      saved: r.comments_saved ?? null,
      skipped: null,
    };
  }
  steps.x = { status: fromStatus(r.x_status), saved: r.x_saved ?? null, skipped: null };
  steps.mentions = { status: fromStatus(r.mentions_status), saved: r.mentions_saved ?? null, skipped: null };
  return steps;
}

// Finished runs of the last 7 days, newest first.
export function healthRuns(rows: HealthRunRow[], now = new Date()): HealthRun[] {
  const since = now.getTime() - 7 * 86_400_000;
  return rows
    .filter((r) => r.status !== "running" && Date.parse(r.started_at) >= since)
    .map((r) => {
      const steps = healthSteps(r);
      return {
        id: r.id,
        kind: r.kind ?? "evening",
        started_at: r.started_at,
        status: r.status,
        failing: HEALTH_STEPS.filter((k) => steps[k]?.status === "failed" || steps[k]?.status === "partial"),
        steps,
      };
    });
}

// "Recurring" when the same step failed on 2 or more of the runs shown.
export function recurringSteps(runs: HealthRun[]): HealthStep[] {
  return HEALTH_STEPS.filter((k) => runs.filter((r) => r.failing.includes(k)).length >= 2);
}

// One table cell: "12 saved · 2 skipped", "failed", "skipped" or "—".
export function cellText(c: StepCell | undefined): string {
  if (!c) return "—";
  if (c.status === "failed") return "failed";
  if (c.status === "skipped" && !c.saved) return "skipped";
  const saved = c.saved == null ? "" : `${c.saved} saved`;
  const skipped = c.skipped ? `${c.skipped} skipped` : "";
  return [saved, skipped].filter(Boolean).join(" · ") || "ok";
}

// For the run tooltip: up to `max` lines of what this run dropped.
export function skippedLines(items: SkippedItem[], runId: number | null | undefined, max = 5): string[] {
  const mine = items.filter((i) => runId != null && i.run_id === runId);
  const lines = mine
    .slice(0, max)
    .map(
      (i) =>
        `- ${i.table_name}: ${i.source_id} (${i.error ?? "refused"})${i.permanent ? " [permanently skipped]" : ""}`,
    );
  if (mine.length > max) lines.push(`- and ${mine.length - max} more (see Sync health)`);
  return lines.length ? [`Skipped items (${mine.length}):`, ...lines] : [];
}
