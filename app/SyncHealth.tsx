"use client";

// "Sync health (7 days)" (signed in): each run, its status, the step that failed, and rows saved
// vs skipped per step; then the items the sync skipped (lib/safeWrite.ts). Collapsed unless a run
// in the last 7 days had a problem.
import { cellText, HEALTH_STEPS, recurringSteps, STEP_LABEL, type HealthRun, type SkippedItem } from "@/lib/health";
import { RUN_LABEL, type RunKind } from "@/lib/runs";

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));

export default function SyncHealth({
  runs,
  skipped,
  rejectsReady,
  maintenanceUrl,
}: {
  runs: HealthRun[];
  skipped: SkippedItem[];
  rejectsReady: boolean;
  maintenanceUrl: string;
}) {
  const problems = runs.filter((r) => r.failing.length || r.status === "failed" || r.status === "partial").length;
  const recurring = recurringSteps(runs);
  return (
    <details className="ov-details sync-health" open={problems > 0 || undefined}>
      <summary>
        Sync health (7 days)
        <span className="muted">
          {runs.length} runs · {problems ? `${problems} with a problem` : "all ok"}
          {recurring.length ? ` · recurring: ${recurring.map((k) => STEP_LABEL[k]).join(", ")}` : ""}
          {skipped.length ? ` · ${skipped.length} skipped items` : ""}
        </span>
      </summary>
      <div className="table-scroll">
        <table className="health-table">
          <thead>
            <tr>
              <th>Run</th>
              <th className="left">Status</th>
              <th className="left">Failing step</th>
              {HEALTH_STEPS.map((k) => (
                <th key={k}>{STEP_LABEL[k]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>
                  {RUN_LABEL[r.kind as RunKind] ?? (r.kind === "backfill" ? "Backfill" : r.kind === "video" ? "Video insights" : r.kind)} · {when(r.started_at)}
                </td>
                <td className="left">
                  <span className={`dot ${r.status}`} />
                  {r.status}
                </td>
                <td className="left">{r.failing.map((k) => STEP_LABEL[k]).join(", ") || "—"}</td>
                {HEALTH_STEPS.map((k) => {
                  const c = r.steps[k];
                  return (
                    <td key={k} className={c ? `step-${c.status}` : undefined} title={c?.error}>
                      {cellText(c)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Saved counts are new or refreshed rows. Skipped counts start once supabase/schema.sql has been re-run (it adds
        sync_rejects); earlier runs show "saved" only.
      </p>
      <h4>Skipped items</h4>
      {!rejectsReady ? (
        <p className="muted small">
          Not recorded yet: run supabase/schema.sql again in Supabase (see{" "}
          <a href={maintenanceUrl} target="_blank" rel="noopener noreferrer">
            How to fix
          </a>
          ).
        </p>
      ) : !skipped.length ? (
        <p className="muted small">None in the last 7 days.</p>
      ) : (
        <ul className="skipped-list">
          {skipped.map((s, i) => (
            <li key={`${s.table_name}-${s.source_id}-${i}`}>
              <span className="muted">{when(s.at)}</span> · {s.step ?? s.table_name} ·{" "}
              {/^https?:\/\//.test(s.source_id) ? (
                <a href={s.source_id} target="_blank" rel="noopener noreferrer">
                  {s.source_id}
                </a>
              ) : (
                <code>{s.source_id}</code>
              )}
              <div className="muted small">
                {s.error ?? "refused"}
                {s.permanent
                  ? " · permanently skipped (refused 3 runs in a row; no longer tried)"
                  : s.strikes > 1
                    ? ` · refused ${s.strikes} runs in a row`
                    : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
