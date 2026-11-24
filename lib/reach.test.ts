import assert from "node:assert/strict";
import { test } from "node:test";
import { customRange } from "./range";
import {
  engagementsOf,
  fmtDays,
  isVideo,
  liLabel,
  missingDays,
  pageTotals,
  postReach,
  publicInteractions,
} from "./reach";

const brands = [
  { id: "m", name: "Resonia", is_montra: true },
  { id: "s", name: "Resonia SCV", is_montra: true },
  { id: "c", name: "Euler Motors", is_montra: false },
] as never[];
const li = (impressions: number, clicks: number, video = false) => ({
  impressions,
  clicks,
  ctr: clicks / impressions,
  reactions: 10,
  comments: 2,
  reposts: 1,
  engagementRate: (clicks + 13) / impressions,
  video,
});
const post = (brand: string, day: string, l?: ReturnType<typeof li>, extra: object = {}) =>
  ({
    url: `${brand}${day}${l?.impressions}`,
    brand,
    posted_at: `${day}T06:00:00Z`,
    likes: 5,
    comments: 1,
    reposts: 1,
    media: "image",
    li: l,
    ...extra,
  }) as never;
const range = customRange("2026-10-01", "2026-10-07", "2026-10-07");

test("post reach: every feed post is organic, ratios of sums, CTR with and without video", () => {
  const posts = [
    post("m", "2026-10-02", li(1000, 10)),
    post("m", "2026-10-03", li(3000, 90)),
    post("m", "2026-10-05", li(4266, 4753)), // more clicks than impressions: still counted
    post("m", "2026-10-06", li(1000, 1500, true)), // video (export Content Type): plays count as clicks
    post("m", "2026-10-06", li(500, 600), { media: "video" }), // video by the tracker's media type
    post("m", "2026-10-04"), // no export row yet
    post("m", "2026-10-04", li(9000, 900), { ad: true }), // an ad (not on feed) never counts
    post("s", "2026-09-20", li(500, 5)), // before the range
    post("c", "2026-10-02", li(9, 9)), // competitors never count
  ];
  const all = postReach(posts, brands, range).all;
  assert.deepEqual([all.posts, all.impressions, all.clicks, all.videos], [5, 9766, 6953, 2]);
  assert.equal(all.ctr, 6953 / 9766);
  // Without video: (10 + 90 + 4,753) ÷ (1,000 + 3,000 + 4,266).
  assert.equal(all.ctrExVideo, 4853 / 8266);
  assert.equal(all.engagements, 6953 + 13 * 5);
  const pages = postReach(posts, brands, range).pages;
  assert.deepEqual(
    pages.map((p) => [p.brand.id, p.posts, p.reach.posts]),
    [
      ["m", 7, 5],
      ["s", 0, 0],
    ],
  );
  assert.equal(isVideo({ media: "image", li: li(1, 1, true) } as never), true);
  assert.equal(engagementsOf(li(100, 7)), 20);
  assert.equal(engagementsOf(undefined), null);
  assert.equal(publicInteractions({ likes: 5, comments: 1, reposts: 1 }), 7);
});

const day = (brand: string, date: string, extra: object) => ({
  brand,
  date,
  impressions: null,
  clicks: null,
  new_followers: null,
  page_views: null,
  unique_visitors: null,
  ...extra,
});
const data = {
  ready: true,
  split: true,
  lastUploaded: "2026-10-06T10:00:00Z",
  pages: [
    day("m", "2026-10-01", {
      impressions: 1500,
      clicks: 1324,
      reactions: 20,
      comments: 1,
      reposts: 0,
      impressions_organic: 1200,
      clicks_organic: 24,
      reactions_organic: 18,
      comments_organic: 1,
      reposts_organic: 0,
      impressions_sponsored: 300,
      clicks_sponsored: 1300,
      reactions_sponsored: 2,
      comments_sponsored: 0,
      reposts_sponsored: 0,
      new_followers: 3,
    }),
    day("m", "2026-10-02", { page_views: 20, unique_visitors: 9, new_followers: 2 }),
    day("s", "2026-10-02", {
      impressions: 50,
      clicks: 1,
      impressions_organic: 50,
      clicks_organic: 1,
      new_followers: 1,
    }),
    day("m", "2026-09-30", { impressions: 999, clicks: 9, impressions_organic: 999, clicks_organic: 9 }),
  ],
};

test("page totals: organic by default, sponsored and all on request, engagements and rates from sums", () => {
  const organic = pageTotals(data, range, ["m"]);
  assert.deepEqual(organic, {
    days: 1,
    impressions: 1200,
    clicks: 24,
    engagements: 43,
    ctr: 0.02,
    er: 43 / 1200,
    newFollowers: 5,
    pageViews: 20,
    uniqueVisitors: 9,
    noSplit: false,
  });
  const all = pageTotals(data, range, ["m"], "all");
  assert.deepEqual([all.impressions, all.clicks, all.engagements], [1500, 1324, 1345]);
  assert.equal(pageTotals(data, range, ["m"], "sponsored").clicks, 1300);
  assert.equal(pageTotals(data, range).impressions, 1250);
  // Uploads from before the split was kept: LinkedIn's totals, flagged.
  const old = { ...data, pages: [day("m", "2026-10-01", { impressions: 1500, clicks: 1324 })] };
  assert.deepEqual([pageTotals(old, range).impressions, pageTotals(old, range).noSplit], [1500, true]);
  assert.equal(pageTotals({ ...data, pages: [] }, range).impressions, null);
  assert.equal(liLabel(data), "from LinkedIn export, last uploaded 6 Oct 2026");
  assert.equal(liLabel({ lastUploaded: null }), "from LinkedIn export, nothing uploaded yet");
});

test("missing dates per page and export, written as day ranges", () => {
  const gaps = missingDays(data, range, (brands as { is_montra: boolean }[]).filter((b) => b.is_montra) as never[]);
  assert.deepEqual(gaps[0].missing.content, [
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
  ]);
  assert.deepEqual(gaps[0].missing.visitors.length, 6);
  assert.equal(fmtDays(gaps[0].missing.content), "2–7 Oct");
  assert.equal(fmtDays(["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-05"]), "29 Sept – 1 Oct, 5 Oct");
  assert.equal(fmtDays([]), "");
});
