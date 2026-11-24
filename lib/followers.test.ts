import assert from "node:assert/strict";
import { test } from "node:test";
import { newFollowers, pageFollowersAt, withExportFollowers, withFollowerFallback } from "./followers";
import { customRange } from "./range";

const day = (brand: string, date: string, total: number | null, organic = total, sponsored = 0) => ({
  brand,
  date,
  impressions: null,
  clicks: null,
  page_views: null,
  unique_visitors: null,
  new_followers: total,
  new_followers_organic: organic,
  new_followers_sponsored: sponsored,
});
const sept = customRange("2026-09-01", "2026-09-30", "2026-10-07");
const days = [
  ...Array.from({ length: 30 }, (_, i) => day("m", `2026-09-${String(i + 1).padStart(2, "0")}`, 10, 8, 2)),
  day("s", "2026-09-01", 5),
  day("s", "2026-09-02", null), // a Content-only day: not counted
  day("m", "2026-10-01", 4),
  day("m", "2026-10-02", 6),
];
const kpi = {
  montraFollowers: null,
  montraGrowth: null,
  montraGrowthPct: null,
  montraPostsPerPage: 1,
  compPostsPerPage: 1,
  montraEr: null,
  compEr: null,
  montraSov: null,
  montraPageCount: 2,
};

test("new followers per page: organic, sponsored and total, with export coverage", () => {
  assert.deepEqual(newFollowers(days, "m", sept), { organic: 240, sponsored: 60, total: 300, days: 30, of: 30 });
  assert.deepEqual(newFollowers(days, "s", sept), { organic: 5, sponsored: 0, total: 5, days: 1, of: 30 });
  assert.deepEqual(newFollowers(days, "x", sept), { organic: null, sponsored: null, total: null, days: 0, of: 30 });
});

test("follower KPIs fall back to the exports when the scraped counts have no value", () => {
  // Counts scraped only from 2 Oct (m) and 5 Oct (s).
  const followers = [
    { brand: "m", date: "2026-10-02", followers: 1000 },
    { brand: "s", date: "2026-10-05", followers: 500 },
  ];
  const k = withExportFollowers(kpi, { days, followers, range: sept, montraIds: ["m", "s"] });
  assert.equal(k.montraGrowth, 305);
  assert.match(k.growthNote!, /LinkedIn new followers \(export\); 1 of 2 pages miss some days/);
  // m: 1,000 on 2 Oct minus the 10 gained on 1-2 Oct; s: no export for 1-5 Oct, so its 5 Oct count.
  assert.equal(k.montraFollowers, 990 + 500);
  assert.match(k.followersNote!, /partly estimated from the export; count on 5 Oct/);
  assert.equal(k.montraGrowthPct, 305 / (1490 - 305));
  // Scraped values are kept when there are any.
  const kept = withExportFollowers(
    { ...kpi, montraFollowers: 7, montraGrowth: 1 },
    { days, followers, range: sept, montraIds: ["m"] },
  );
  assert.deepEqual(
    [kept.montraFollowers, kept.montraGrowth, kept.followersNote, kept.growthNote],
    [7, 1, undefined, undefined],
  );
});

test("per-page followers and the leaderboard fallback", () => {
  const followers = [
    { brand: "m", date: "2026-10-02", followers: 1000 },
    { brand: "c", date: "2026-10-05", followers: 500 },
  ];
  // m: the exports cover 1-2 Oct, so 1,000 minus the 10 gained then; c: its 5 Oct count, dated.
  assert.deepEqual(pageFollowersAt(followers, days, "m", "2026-09-30"), { value: 990, estimated: true });
  assert.deepEqual(pageFollowersAt(followers, days, "c", "2026-09-30"), { value: 500, asOf: "2026-10-05" });
  assert.deepEqual(pageFollowersAt(followers, days, "m", "2026-10-03"), { value: 1000 });
  assert.deepEqual(pageFollowersAt(followers, days, "x", "2026-09-30"), { value: null });
  const row = (id: string, is_montra: boolean) => ({
    brand: { id, is_montra },
    followers: null,
    growth: null,
    growthPct: null,
    posts: 2,
    avgLikes: 9,
    avgComments: 1,
    engagementRate: null,
  });
  const { rows, notes } = withFollowerFallback([row("m", true), row("c", false)], { followers, days, range: sept });
  assert.deepEqual(
    rows.map((r) => [r.followers, r.growth, r.engagementRate]),
    [
      [990, 300, 10 / 990],
      [500, null, 10 / 500],
    ],
  );
  assert.match(notes.get("m")!.followers!, /^Estimated/);
  assert.equal(notes.get("m")!.growth, "LinkedIn new followers (export)");
  assert.equal(notes.get("c")!.followers, "Count on 5 Oct (first count after this period)");
});
