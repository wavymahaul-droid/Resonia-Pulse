import assert from "node:assert/strict";
import { test } from "node:test";
import {
  customRange,
  fmtRange,
  inRange,
  istToday,
  loadSince,
  presetRange,
  rangeDays,
  rangeFromParams,
  rangePhrase,
  rangeQuery,
  stepRange,
} from "./range";

const today = "2026-10-06";

test("quick options", () => {
  const r = (k: Parameters<typeof presetRange>[0]) => {
    const { from, to } = presetRange(k, today);
    return [from, to];
  };
  assert.deepEqual(r("today"), [today, today]);
  assert.deepEqual(r("yesterday"), ["2026-10-05", "2026-10-05"]);
  assert.deepEqual(r("7d"), ["2026-09-30", today]);
  assert.deepEqual(r("30d"), ["2026-09-07", today]);
  assert.deepEqual(r("thisMonth"), ["2026-10-01", today]);
  assert.deepEqual(r("lastMonth"), ["2026-09-01", "2026-09-30"]);
  assert.deepEqual(
    [presetRange("lastMonth", "2026-01-15").from, presetRange("lastMonth", "2026-01-15").to],
    ["2025-12-01", "2025-12-31"],
  );
  assert.deepEqual(
    [presetRange("lastMonth", "2028-03-01").from, presetRange("lastMonth", "2028-03-01").to],
    ["2028-02-01", "2028-02-29"],
  );
  assert.equal(rangeDays(presetRange("7d", today)), 7);
});

test("custom ranges are clamped to today and put in order", () => {
  assert.deepEqual(customRange("2026-10-06", "2026-10-01", today), {
    key: "custom",
    from: "2026-10-01",
    to: "2026-10-06",
  });
  assert.equal(customRange("2026-10-01", "2026-12-01", today).to, today);
  assert.ok(inRange("2026-10-03", customRange("2026-10-01", "2026-10-06", today)));
  assert.ok(!inRange("2026-09-30", customRange("2026-10-01", "2026-10-06", today)));
  assert.ok(!inRange(null, customRange("2026-10-01", "2026-10-06", today)));
});

test("page link round trip, old digest links and bad input", () => {
  for (const r of [presetRange("7d", today), customRange("2026-10-01", "2026-10-06", today)]) {
    const params = Object.fromEntries(new URLSearchParams(rangeQuery(r)));
    assert.deepEqual(rangeFromParams(params, today, "30d"), r);
  }
  assert.deepEqual(
    rangeFromParams({ date: "2026-10-02" }, today, "today"),
    customRange("2026-10-02", "2026-10-02", today),
  );
  assert.deepEqual(rangeFromParams({ range: "nonsense" }, today, "30d"), presetRange("30d", today));
  assert.deepEqual(
    rangeFromParams({ range: "custom", from: "x", to: "y" }, today, "today"),
    presetRange("today", today),
  );
  assert.deepEqual(rangeFromParams({}, today, "today"), presetRange("today", today));
});

test("labels", () => {
  assert.equal(fmtRange({ from: "2026-10-06", to: "2026-10-06" }), "6 Oct 2026");
  assert.equal(fmtRange({ from: "2026-10-01", to: "2026-10-06" }), "1–6 Oct 2026");
  assert.equal(fmtRange({ from: "2026-09-28", to: "2026-10-06" }), "28 Sep – 6 Oct 2026");
  assert.equal(fmtRange({ from: "2025-12-30", to: "2026-01-02" }), "30 Dec 2025 – 2 Jan 2026");
  assert.equal(rangePhrase(presetRange("30d", today)), "last 30 days");
  assert.equal(rangePhrase(customRange("2026-10-01", "2026-10-06", today)), "1–6 Oct 2026");
});

test("stepping and how far back to load", () => {
  const r = customRange("2026-10-01", "2026-10-03", today);
  assert.deepEqual(stepRange(r, -1, today), customRange("2026-09-28", "2026-09-30", today));
  assert.deepEqual(stepRange(presetRange("today", today), -1, today), customRange("2026-10-05", "2026-10-05", today));
  const now = new Date("2026-10-06T06:00:00Z");
  assert.equal(istToday(new Date("2026-10-05T19:00:00Z")), "2026-10-06"); // 00:30 IST
  // Recent ranges load the usual 91 days; older ones load back to a week before the start.
  assert.equal(loadSince(presetRange("30d", today), now), "2026-07-07T06:00:00.000Z");
  assert.equal(loadSince(customRange("2026-01-10", "2026-01-20", today), now), "2026-01-02T18:30:00.000Z");
});
