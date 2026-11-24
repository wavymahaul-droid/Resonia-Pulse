// Plain-English warnings for the dashboard banner (signed-in viewers only), worked out from the
// latest rows of sync_runs. MAINTENANCE.md explains each one and how to fix it.

export type RunRow = {
  kind?: string | null; // morning / afternoon / evening (missing before schema.sql adds it: evening)
  started_at: string;
  status: string; // running / success / partial / failed / skipped
  notes: string | null;
  pages_failed: string[] | null; // pages that returned no posts
  pages_attempted: string[] | null; // pages that were due
};

const istDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));

// Why a run failed, in words someone without the code can act on.
export function explainFailure(notes: string | null): string {
  const n = notes ?? "";
  if (/APIFY_TOKEN is not set|APIFY_TOKEN is set but empty|token-not-provided/i.test(n)) {
    return "Apify rejected the token: re-paste APIFY_TOKEN in Vercel and redeploy.";
  }
  if (/user-or-token-not-found|Apify 401/i.test(n)) {
    return "Apify did not recognise the token (it may have been changed or deleted): copy the API token from Apify (Settings → API & Integrations), paste it into APIFY_TOKEN in Vercel and redeploy.";
  }
  if (/Apify 40[23]|usage hard limit|platform-feature-disabled|not enough.*(credit|usage)/i.test(n)) {
    return "Apify's free monthly credit is used up: syncing starts again by itself when Apify's monthly cycle resets.";
  }
  if (/does not exist|schema is out of date|re-run supabase\/schema\.sql/i.test(n)) {
    return "The database is missing a table or column: run supabase/schema.sql again in the Supabase SQL editor.";
  }
  if (/Invalid API key|JWT|SUPABASE_URL|SUPABASE_SERVICE_KEY/i.test(n)) {
    return "The database rejected the sync: re-paste SUPABASE_URL and SUPABASE_SERVICE_KEY in Vercel and redeploy.";
  }
  if (/invalid input syntax for type json|unsupported Unicode escape|items? skipped/i.test(n)) {
    return "Some items could not be saved (usually an unusual character in a post) and were skipped; everything else was saved. See Sync health (7 days) on the dashboard for the list.";
  }
  if (/fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|Apify 5\d\d|timed? ?out|FUNCTION_INVOCATION_TIMEOUT/i.test(n)) {
    return "A service did not answer in time (Apify, LinkedIn or the database). This usually fixes itself on the next daily run; if it repeats for several days, see MAINTENANCE.md.";
  }
  return `The last sync failed: ${n.replace(/\s+/g, " ").slice(0, 200) || "no reason was recorded"}.`;
}

export function syncWarnings(
  runs: RunRow[], // newest first
  brands: { id: string; name: string }[],
  now = new Date(),
): string[] {
  const out: string[] = [];
  const finished = runs.filter((r) => r.status !== "running");
  // The evening run does everything; the morning and afternoon scans only X and LinkedIn mentions.
  const done = finished.filter((r) => (r.kind ?? "evening") === "evening");
  const last = done[0];
  if (!last) return ["No sync has run yet. The first one runs at 17:00 IST."];

  // The evening run is daily at 17:00 IST; more than 30 hours without one means it stopped.
  const hours = (now.getTime() - Date.parse(last.started_at)) / 3_600_000;
  if (hours > 30) {
    out.push(
      `No sync has run for ${Math.floor(hours / 24)} day(s) (last one ${istDay(last.started_at)}): check that the Vercel project still has its daily Cron Job and that the latest deployment succeeded.`,
    );
  }

  if (last.status === "failed") out.push(explainFailure(last.notes));
  if (last.status === "skipped") {
    const m = last.notes?.match(/\$([\d.]+), above the \$([\d.]+) limit/);
    out.push(
      `The last sync was skipped for budget: Apify usage this month${m ? ` ($${m[1]})` : ""} is above the${m ? ` $${m[2]}` : ""} limit in APIFY_MONTHLY_BUDGET_USD. Syncing starts again when Apify's monthly cycle resets; see MAINTENANCE.md before raising the limit.`,
    );
  }
  if (last.status !== "failed" && last.status !== "skipped") {
    const parts = [
      /Comments skipped: Apify usage/.test(last.notes ?? "") ? "comments" : "",
      /X skipped: Apify usage/.test(last.notes ?? "") ? "X" : "",
      /LinkedIn mentions skipped: Apify usage/.test(last.notes ?? "") ? "LinkedIn mentions" : "",
    ].filter(Boolean);
    if (parts.length) {
      out.push(
        `The Apify budget is nearly used up, so ${parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]} ${parts.length > 1 ? "were" : "was"} skipped in the last sync (LinkedIn posts still sync). ${parts.length > 1 ? "They start" : "It starts"} again when there is room in the budget or the monthly cycle resets.`,
      );
    }
    // A later step of the evening run (comments, X, LinkedIn mentions) failed or skipped many rows.
    if (last.status === "partial" && /(Comments|X|LinkedIn mentions) failed|items? skipped/.test(last.notes ?? "")) {
      out.push(`The evening sync had a problem: ${explainFailure(last.notes)}`);
    }
    if (/schema is out of date/i.test(last.notes ?? "")) {
      out.push("The database is missing a table or column: run supabase/schema.sql again in the Supabase SQL editor.");
    }
  }

  // The latest morning and afternoon scans: failures, and X or mentions skipped for budget.
  for (const kind of ["morning", "afternoon"]) {
    const scan = finished.find((r) => r.kind === kind);
    if (!scan) continue;
    const name = kind === "morning" ? "The morning scan" : "The afternoon scan";
    if (scan.status === "failed" || scan.status === "partial") {
      out.push(`${name} had a problem: ${explainFailure(scan.notes)}`);
    } else if (scan.status === "skipped" && /Apify usage/.test(scan.notes ?? "")) {
      out.push(`${name} was skipped for budget: Apify usage this month is above APIFY_MONTHLY_BUDGET_USD.`);
    }
  }

  // A page that came back with no posts on each of its last 3 sync days (latest run per day).
  const byDay = new Map<string, RunRow>();
  for (const r of done) {
    if (!r.pages_attempted?.length) continue; // skipped, failed early, or nothing was due
    const day = istDay(r.started_at);
    if (!byDay.has(day)) byDay.set(day, r);
  }
  const days = [...byDay.values()];
  const silent = brands.filter((b) => {
    const tried = days.filter((r) => r.pages_attempted!.includes(b.id)).slice(0, 3);
    return tried.length === 3 && tried.every((r) => (r.pages_failed ?? []).includes(b.id));
  });
  if (silent.length) {
    out.push(
      `LinkedIn returned no posts for ${silent.map((b) => b.name).join(", ")} 3 days in a row: open the page link in brands.json to check it still works (the page may have been renamed or removed) and fix the link on GitHub.`,
    );
  }
  return out;
}
