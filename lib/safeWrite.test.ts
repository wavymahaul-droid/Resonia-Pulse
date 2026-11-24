import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cellText, healthRuns, healthSteps, recurringSteps, skippedLines } from "./health";
import { safeWrite, skippedNote, stepStats, type WriteResult } from "./safeWrite";

// A stand-in for Supabase that refuses rows the way Postgres did: a lone surrogate or \u0000 in
// any string, or a null `likes` (not null).
type Row = Record<string, unknown>;
function fakeDb({ rejectsTable = true } = {}) {
  const tables: Record<string, Row[]> = { sync_rejects: [] };
  const calls: { table: string; op: string; size: number }[] = [];
  const bad = (r: Row) =>
    /[\uD800-\uDFFF]|\u0000/.test(JSON.stringify(r).replace(/\\u[0-9a-f]{4}/gi, (e) => JSON.parse(`"${e}"`))) ||
    r.likes === null;
  const db = {
    from(table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let op = "select";
      let patch: Row = {};
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
        in: (k: string, v: unknown[]) => (filters.push((r) => v.includes(r[k])), q),
        update: (p: Row) => ((op = "update"), (patch = p), q),
        insert: (rows: Row[]) => write(table, rows),
        upsert: (rows: Row[]) => write(table, rows),
        then: (ok: (v: unknown) => void) => {
          if (table === "sync_rejects" && !rejectsTable) return ok({ data: null, error: { message: "no table" } });
          const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          if (op === "update") hit.forEach((r) => Object.assign(r, patch));
          return ok({ data: hit, error: null });
        },
      };
      return q;
    },
  };
  function write(table: string, rows: Row[]) {
    calls.push({ table, op: "write", size: rows.length });
    if (table === "sync_rejects" && !rejectsTable) return Promise.resolve({ error: { message: "no table" } });
    if (rows.some(bad)) return Promise.resolve({ error: { message: "invalid input syntax for type json" } });
    (tables[table] ??= []).push(...rows.map((r) => ({ cleared: false, permanent: false, ...r })));
    return Promise.resolve({ error: null });
  }
  return { db: db as unknown as SupabaseClient, tables, calls };
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, likes: 1, text: `post ${i}` }));

test("clean rows are saved in one batch", async () => {
  const { db, tables, calls } = fakeDb();
  const r = await safeWrite(db, { table: "linkedin_mentions", rows: rows(5), key: (x) => x.id, runId: 1 });
  assert.equal(r.saved, 5);
  assert.deepEqual(r.rejected, []);
  assert.deepEqual(calls, [{ table: "linkedin_mentions", op: "write", size: 5 }]);
  assert.equal(tables.linkedin_mentions.length, 5);
});

test("bad characters are cleaned before writing, so the batch goes through", async () => {
  const { db, tables } = fakeDb();
  const list = rows(3);
  list[1].text = "half \uDC1B letter \u0000";
  const r = await safeWrite(db, { table: "linkedin_mentions", rows: list, key: (x) => x.id, runId: 1 });
  assert.equal(r.saved, 3);
  assert.equal(tables.linkedin_mentions[1].text, "half  letter ");
});

test("a refused batch falls back to row by row; the bad row is skipped and logged", async () => {
  const { db, tables } = fakeDb();
  const list = rows(4);
  list[2].likes = NaN; // becomes null: refused (not null)
  const r = await safeWrite(db, { table: "comments", rows: list, key: (x) => x.id, runId: 7, step: "comments" });
  assert.equal(r.saved, 3);
  assert.deepEqual(r.savedIds, ["m0", "m1", "m3"]);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].sourceId, "m2");
  const log = tables.sync_rejects[0];
  assert.equal(log.table_name, "comments");
  assert.equal(log.run_id, 7);
  assert.equal(log.step, "comments");
  assert.match(String(log.error), /invalid input syntax/);
  assert.match(String(log.payload), /"id":"m2"/);
  assert.equal(log.strikes, 1);
});

test("refused on 3 runs in a row: permanently skipped, then no longer tried", async () => {
  const { db, tables } = fakeDb();
  const bad = [{ id: "x1", likes: NaN }];
  for (const run of [1, 2, 3]) await safeWrite(db, { table: "posts", rows: bad, key: (x) => x.id, runId: run });
  assert.deepEqual(
    tables.sync_rejects.map((r) => [r.strikes, r.permanent]),
    [
      [1, false],
      [2, false],
      [3, true],
    ],
  );
  const r4 = await safeWrite(db, {
    table: "posts",
    rows: [...bad, { id: "ok", likes: 1 }],
    key: (x) => x.id,
    runId: 4,
  });
  assert.equal(r4.permanent, 1);
  assert.equal(r4.rejected.length, 0);
  assert.equal(r4.saved, 1);
  assert.equal(tables.sync_rejects.length, 3);
});

test("a save in between resets the count", async () => {
  const { db, tables } = fakeDb();
  const w = (likes: number, run: number) =>
    safeWrite(db, { table: "posts", rows: [{ id: "p", likes }], key: (x) => x.id, runId: run });
  await w(NaN, 1);
  await w(NaN, 2);
  await w(5, 3); // saved: the two refusals are cleared
  assert.ok(tables.sync_rejects.every((r) => r.cleared));
  const r = await w(NaN, 4);
  assert.equal(r.rejected[0].permanent, false);
  assert.equal(tables.sync_rejects.at(-1)!.strikes, 1);
});

test("without the sync_rejects table rows are still skipped, not thrown", async () => {
  const { db } = fakeDb({ rejectsTable: false });
  const list = rows(3);
  list[0].likes = NaN;
  const r = await safeWrite(db, { table: "posts", rows: list, key: (x) => x.id });
  assert.equal(r.saved, 2);
  assert.equal(r.rejected.length, 1);
});

const result = (attempted: number, skipped: number): WriteResult => ({
  table: "t",
  attempted,
  saved: attempted - skipped,
  savedIds: [],
  rejected: Array.from({ length: skipped }, (_, i) => ({ table: "t", sourceId: `${i}`, error: "e", permanent: false })),
  permanent: 0,
});

test("a step is partial only above 20% skipped, or when it throws", () => {
  assert.equal(stepStats([result(20, 2)]).status, "ok");
  assert.equal(stepStats([result(20, 4)]).status, "ok"); // exactly 20%
  assert.equal(stepStats([result(20, 5)]).status, "partial");
  assert.equal(stepStats([], { error: "boom" }).status, "failed");
  assert.equal(stepStats([], { skipped: true }).status, "skipped");
  assert.deepEqual(stepStats([result(10, 2)]), { status: "ok", saved: 8, skipped: 2 });
  assert.equal(skippedNote("LinkedIn mentions", [result(10, 2)]), "LinkedIn mentions: 2 items skipped");
  assert.equal(skippedNote("X", [result(10, 0)]), "");
});

test("sync health: old runs read from their columns, new ones from step_stats", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const runs = healthRuns(
    [
      {
        id: 24,
        kind: "morning",
        started_at: "2026-10-12T02:08:43Z",
        status: "partial",
        notes:
          "Morning scan. LinkedIn mentions failed: Error: linkedin_mentions insert: invalid input syntax for type json",
        x_status: "success",
        x_saved: 0,
        mentions_status: "failed",
        mentions_saved: 0,
      },
      {
        id: 23,
        kind: "evening",
        started_at: "2026-10-11T11:54:22Z",
        status: "success",
        notes: "Comments saved: 5. LinkedIn mentions failed: Error",
        posts_saved: 30,
        comments_saved: 5,
        x_status: "success",
        mentions_status: "failed",
      },
      {
        id: 25,
        kind: "afternoon",
        started_at: "2026-10-12T08:14:00Z",
        status: "success",
        notes: "Afternoon scan",
        step_stats: { x: { status: "ok", saved: 1, skipped: 0 }, mentions: { status: "ok", saved: 4, skipped: 1 } },
      },
      { id: 1, kind: "evening", started_at: "2026-10-01T11:54:00Z", status: "success", notes: null }, // older than 7 days
    ],
    now,
  );
  assert.deepEqual(
    runs.map((r) => [r.id, r.failing]),
    [
      [24, ["mentions"]],
      [23, ["mentions"]],
      [25, []],
    ],
  );
  assert.deepEqual(recurringSteps(runs), ["mentions"]);
  assert.equal(cellText(runs[1].steps.posts), "30 saved");
  assert.equal(cellText(runs[0].steps.mentions), "failed");
  assert.equal(cellText(runs[2].steps.mentions), "4 saved · 1 skipped");
  assert.equal(cellText(runs[0].steps.posts), "—");
  assert.equal(
    healthSteps({ id: 2, started_at: "", status: "success", notes: "No pages due today" }).posts?.status,
    "skipped",
  );
  assert.deepEqual(
    skippedLines(
      [
        {
          at: "",
          run_id: 25,
          step: "mentions",
          table_name: "linkedin_mentions",
          source_id: "7514512753328304128",
          error: "invalid input syntax for type json",
          strikes: 1,
          permanent: false,
        },
      ],
      25,
    ),
    ["Skipped items (1):", "- linkedin_mentions: 7514512753328304128 (invalid input syntax for type json)"],
  );
});
