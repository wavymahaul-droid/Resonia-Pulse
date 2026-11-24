import assert from "node:assert/strict";
import { test } from "node:test";
import type { FollowerPoint, LiPageDay } from "./dashboard";
import { dailyGains, followerRows, paceFor, periodGain, projectMonthEnd } from "./followerDaily";

const P = "montraelectric";
const exp = (date: string, n: number | null, brand = P) => ({ brand, date, new_followers: n }) as unknown as LiPageDay;
const snap = (date: string, followers: number, brand = P): FollowerPoint => ({ brand, date, followers });

test("the export wins over our own estimate for the same day", () => {
  const days = [exp("2026-11-02", 40)];
  const counts = [snap("2026-11-01", 1000), snap("2026-11-02", 1025), snap("2026-11-03", 1055)];
  const out = dailyGains(P, days, counts, "2026-11-02", "2026-11-03");
  assert.deepEqual(out[0], { date: "2026-11-02", value: 40, source: "export" }); // not 25
  assert.deepEqual(out[1], { date: "2026-11-03", value: 30, source: "estimate" });
});

test("an export day with no number falls back to the estimate, then to a gap", () => {
  const days = [exp("2026-11-02", null), exp("2026-11-03", null)];
  const counts = [snap("2026-11-01", 1000), snap("2026-11-02", 1010)];
  const out = dailyGains(P, days, counts, "2026-11-02", "2026-11-03");
  assert.equal(out[0].source, "estimate");
  assert.equal(out[0].value, 10);
  assert.deepEqual(out[1], { date: "2026-11-03", value: null, source: null });
});

test("days without data are gaps, never zero", () => {
  // Counts on the 11th and the 14th only: the 12th, 13th and 14th have no single-day number.
  const counts = [snap("2026-11-10", 900), snap("2026-11-11", 910), snap("2026-11-14", 970)];
  const out = dailyGains(P, [], counts, "2026-11-11", "2026-11-14");
  assert.deepEqual(
    out.map((d) => d.value),
    [10, null, null, null],
  );
  assert.ok(out.slice(1).every((d) => d.source === null));
});

test("a zero from the export stays a real zero", () => {
  const out = dailyGains(P, [exp("2026-11-02", 0)], [], "2026-11-02", "2026-11-02");
  assert.deepEqual(out[0], { date: "2026-11-02", value: 0, source: "export" });
});

test("a period total includes the change across a stretch of missed days", () => {
  const counts = [snap("2026-11-10", 900), snap("2026-11-11", 910), snap("2026-11-14", 970)];
  const g = periodGain(P, [], counts, "2026-11-11", "2026-11-14");
  assert.deepEqual(g, { value: 70, estimated: true, missingDays: 0, days: 4 });
});

test("a period total reports the days it could not count", () => {
  // No count before the 3rd: the 1st to the 3rd cannot be measured.
  const counts = [snap("2026-11-03", 500), snap("2026-11-04", 520), snap("2026-11-05", 530)];
  const g = periodGain(P, [], counts, "2026-11-01", "2026-11-06");
  assert.equal(g.value, 30);
  assert.equal(g.missingDays, 4); // 1, 2, 3 and 6
  const none = periodGain(P, [], [], "2026-11-01", "2026-11-06");
  assert.equal(none.value, null); // not 0
});

test("a period mixes export days with estimates without counting a day twice", () => {
  const days = [exp("2026-11-01", 10), exp("2026-11-02", 12)];
  const counts = [
    snap("2026-11-01", 1000),
    snap("2026-11-02", 1011),
    snap("2026-11-03", 1020),
    snap("2026-11-04", 1035),
  ];
  const g = periodGain(P, days, counts, "2026-11-01", "2026-11-04");
  // 10 + 12 from the export; 3rd and 4th from the counts: 1035 - 1011 = 24
  assert.deepEqual(g, { value: 46, estimated: true, missingDays: 0, days: 4 });
  const onlyExport = periodGain(P, days, counts, "2026-11-01", "2026-11-02");
  assert.equal(onlyExport.estimated, false);
});

test("an export uploaded later fills a gap", () => {
  const counts = [snap("2026-11-11", 910), snap("2026-11-14", 970)];
  const before = dailyGains(P, [], counts, "2026-11-12", "2026-11-13");
  assert.ok(before.every((d) => d.value === null));
  const after = dailyGains(P, [exp("2026-11-12", 18), exp("2026-11-13", 22)], counts, "2026-11-12", "2026-11-13");
  assert.deepEqual(
    after.map((d) => [d.value, d.source]),
    [
      [18, "export"],
      [22, "export"],
    ],
  );
});

test("projection uses the daily average of the days counted, and the pace needs a target", () => {
  assert.equal(projectMonthEnd({ value: 140, estimated: true, missingDays: 0, days: 14 }, "2026-11-14"), 300);
  // 2 of 14 days missing: 120 over 12 days = 10 a day
  assert.equal(projectMonthEnd({ value: 120, estimated: true, missingDays: 2, days: 14 }, "2026-11-14"), 300);
  assert.equal(projectMonthEnd({ value: null, estimated: false, missingDays: 14, days: 14 }, "2026-11-14"), null);
  assert.equal(paceFor(300, null), null);
  assert.equal(paceFor(300, 250), "on track");
  assert.equal(paceFor(300, 400), "behind");
  assert.equal(paceFor(null, 400), null);
});

test("rows: today, week, month to date, same point last month and the combined row", () => {
  const A = "a";
  const B = "b";
  const counts: FollowerPoint[] = [];
  // Page a: +10 a day from 30 Sep to 14 Nov, but no counts on 12 and 13 Nov.
  // Page b: +5 a day, every day.
  for (let d = "2026-09-30", n = 0; d <= "2026-11-14"; n++) {
    if (d !== "2026-11-12" && d !== "2026-11-13") counts.push(snap(d, 1000 + 10 * n, A));
    counts.push(snap(d, 500 + 5 * n, B));
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  const rows = followerRows({
    pages: [
      { id: A, label: "A" },
      { id: B, label: "B" },
    ],
    days: [exp("2026-10-01", 30, A)], // LinkedIn's own number for one day last month
    followers: counts,
    today: "2026-11-14",
    targets: { a: 250, b: 200 },
  });
  const [a, b, all] = rows;
  assert.equal(a.chart.length, 14);
  assert.equal(a.today.value, null); // no count on the 13th: today's own change is unknown
  assert.equal(a.mtd.value, 140); // but the month to date still adds up
  assert.equal(a.mtd.missingDays, 0);
  assert.equal(a.week.value, 60); // Mon 9 to Sat 14
  assert.equal(a.lastMonthSamePoint.value, 30 + 130); // export on 1 Oct, counts for 2 to 14 Oct
  assert.equal(a.projected, 300);
  assert.equal(a.pace, "on track");
  assert.equal(a.total, 1450);
  assert.equal(b.today.value, 5);
  assert.equal(b.projected, 150);
  assert.equal(b.pace, "behind");
  assert.equal(all.id, "all");
  assert.equal(all.today.value, null); // a gap for one page is a gap for the total
  assert.equal(all.chart[10].value, 15); // 11 Nov
  assert.equal(all.chart[11].value, null); // 12 Nov
  assert.equal(all.mtd.value, 210);
  assert.equal(all.total, 1450 + 725);
  assert.equal(all.target, 450);
  assert.equal(all.pace, "on track"); // projected 450
});
