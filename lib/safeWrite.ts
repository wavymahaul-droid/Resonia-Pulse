// Every sync write goes through safeWrite(), so one bad record can never fail a whole step:
// rows are cleaned (lib/sanitise.ts), written in batches, and a batch the database refuses is
// retried row by row. A row that still fails is skipped and logged to sync_rejects with the run,
// its id or link, the error and the start of its payload. An item refused on 3 runs in a row is
// marked permanently skipped: it is no longer tried, and no longer counted as a skipped item.
// Server only.
import type { SupabaseClient } from "@supabase/supabase-js";
import { clip, sanitiseRow } from "@/lib/sanitise";

export const BATCH_SIZE = 200;
export const PERMANENT_AFTER = 3; // runs in a row
export const PAYLOAD_SNIPPET = 500; // characters of the row kept in sync_rejects
// A step is "partial" only when more than this share of its rows is skipped (or the step throws).
export const PARTIAL_SHARE = 0.2;

export type Reject = { table: string; sourceId: string; error: string; permanent: boolean };

export type WriteResult = {
  table: string;
  attempted: number; // rows offered (permanently skipped ones included)
  saved: number;
  savedIds: string[]; // key() of each saved row
  rejected: Reject[]; // skipped this run
  permanent: number; // not tried: permanently skipped earlier
};

export type WriteOptions<T> = {
  table: string;
  rows: T[];
  key: (row: T) => string; // the row's id or link, for the log
  mode?: "insert" | "upsert";
  onConflict?: string;
  ignoreDuplicates?: boolean;
  jsonColumns?: readonly string[];
  runId?: number | null;
  step?: string;
  batchSize?: number;
};

type Prior = { source_id: string; run_id: number | null; permanent: boolean };

const errText = (e: unknown) =>
  e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);

async function priorRejects(db: SupabaseClient, table: string, ids: string[]): Promise<Prior[] | null> {
  const out: Prior[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const { data, error } = await db
      .from("sync_rejects")
      .select("source_id,run_id,permanent")
      .eq("table_name", table)
      .eq("cleared", false)
      .in("source_id", ids.slice(i, i + 50));
    if (error) return null; // no sync_rejects table yet: rows are still skipped, just not logged
    out.push(...(data as Prior[]));
  }
  return out;
}

export async function safeWrite<T extends Record<string, unknown>>(
  db: SupabaseClient,
  opts: WriteOptions<T>,
): Promise<WriteResult> {
  const { table, key, mode = "insert", runId = null, step = null, batchSize = BATCH_SIZE } = opts;
  const result: WriteResult = {
    table,
    attempted: opts.rows.length,
    saved: 0,
    savedIds: [],
    rejected: [],
    permanent: 0,
  };
  if (!opts.rows.length) return result;

  // Clean every row; a row that cannot even be cleaned is rejected straight away.
  const failed: { row: T; id: string; error: string }[] = [];
  let rows: { row: T; id: string }[] = [];
  for (const raw of opts.rows) {
    const id = clip(String(key(raw)), 500);
    try {
      rows.push({ row: sanitiseRow(raw, opts.jsonColumns), id });
    } catch (err) {
      failed.push({ row: raw, id, error: `Could not clean the row: ${errText(err)}` });
    }
  }

  const prior = await priorRejects(db, table, [...new Set(rows.map((r) => r.id).concat(failed.map((f) => f.id)))]);
  const permanent = new Set((prior ?? []).filter((p) => p.permanent).map((p) => p.source_id));
  result.permanent = rows.filter((r) => permanent.has(r.id)).length;
  rows = rows.filter((r) => !permanent.has(r.id));

  const write = (list: T[]) => {
    const q = db.from(table);
    const body = list as Record<string, unknown>[];
    return mode === "upsert"
      ? q.upsert(body, { onConflict: opts.onConflict, ignoreDuplicates: opts.ignoreDuplicates })
      : q.insert(body);
  };
  const savedIds: string[] = [];
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await write(batch.map((r) => r.row));
    if (!error) {
      savedIds.push(...batch.map((r) => r.id));
      continue;
    }
    // The batch was refused: find the bad rows one by one, keep the rest.
    for (const r of batch) {
      const { error: e } = batch.length === 1 ? { error } : await write([r.row]);
      if (e) failed.push({ row: r.row, id: r.id, error: e.message });
      else savedIds.push(r.id);
    }
  }
  result.saved = savedIds.length;
  result.savedIds = savedIds;

  // Strikes: earlier runs that refused the same item since it last saved, plus this one.
  const runsBefore = new Map<string, Set<number | null>>();
  for (const p of prior ?? []) {
    if (p.permanent || p.run_id === runId) continue;
    runsBefore.set(p.source_id, (runsBefore.get(p.source_id) ?? new Set()).add(p.run_id));
  }
  result.rejected = failed.map((f) => ({
    table,
    sourceId: f.id,
    error: clip(f.error, 500),
    permanent: (runsBefore.get(f.id)?.size ?? 0) + 1 >= PERMANENT_AFTER,
  }));
  for (const r of result.rejected) {
    console.warn(`${table}: skipped ${r.sourceId}: ${r.error}${r.permanent ? " (now permanently skipped)" : ""}`);
  }

  if (prior) {
    if (failed.length) {
      const payload = (row: T) => {
        try {
          return clip(JSON.stringify(sanitiseRow(row)), PAYLOAD_SNIPPET, true);
        } catch {
          return clip(String(row), PAYLOAD_SNIPPET, true);
        }
      };
      const { error } = await db
        .from("sync_rejects")
        .insert(
          failed.map((f, i) => ({
            run_id: runId,
            step,
            table_name: table,
            source_id: f.id,
            error: result.rejected[i].error,
            payload: payload(f.row),
            strikes: (runsBefore.get(f.id)?.size ?? 0) + 1,
            permanent: result.rejected[i].permanent,
          })),
        );
      if (error) console.warn(`sync_rejects insert: ${error.message}`);
    }
    // Saved now: earlier refusals no longer count towards "3 runs in a row".
    const cleared = [...new Set(savedIds.filter((id) => runsBefore.has(id)))];
    for (let i = 0; i < cleared.length; i += 50) {
      await db
        .from("sync_rejects")
        .update({ cleared: true })
        .eq("table_name", table)
        .eq("permanent", false)
        .in("source_id", cleared.slice(i, i + 50));
    }
  }
  return result;
}

// ---------- step outcome ----------

export type StepStats = {
  status: "ok" | "partial" | "failed" | "skipped";
  saved: number;
  skipped: number; // rejected rows this run
  error?: string;
};

// Combines a step's writes. Partial only when more than PARTIAL_SHARE of its rows were skipped.
export function stepStats(
  writes: WriteResult[],
  { error, skipped: stepSkipped = false }: { error?: string; skipped?: boolean } = {},
): StepStats {
  const saved = writes.reduce((s, w) => s + w.saved, 0);
  const skipped = writes.reduce((s, w) => s + w.rejected.length, 0);
  const tried = writes.reduce((s, w) => s + w.attempted - w.permanent, 0);
  const status = error
    ? "failed"
    : tried && skipped / tried > PARTIAL_SHARE
      ? "partial"
      : stepSkipped && !tried
        ? "skipped"
        : "ok";
  return { status, saved, skipped, ...(error ? { error: clip(error, 300) } : {}) };
}

// "2 items skipped" for the run notes; empty when nothing was skipped.
export function skippedNote(label: string, writes: WriteResult[]): string {
  const n = writes.reduce((s, w) => s + w.rejected.length, 0);
  if (!n) return "";
  const perm = writes.reduce((s, w) => s + w.rejected.filter((r) => r.permanent).length, 0);
  return `${label}: ${n} item${n === 1 ? "" : "s"} skipped${perm ? ` (${perm} now permanently)` : ""}`;
}
