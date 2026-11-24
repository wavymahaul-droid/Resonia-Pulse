import assert from "node:assert/strict";
import { test } from "node:test";
import {
  earnedOwned,
  fmtHours,
  growthCurve,
  growthStats,
  median,
  mediaOutlets,
  previousRange,
  responseTimes,
  trends,
  weeksOf,
} from "./analytics";
import { customRange } from "./range";

const today = "2026-10-26";
const brands = [
  { id: "m", name: "Resonia", segment: "linkedin", is_montra: true },
  { id: "c", name: "Euler Motors", segment: "facebook", is_montra: false },
  { id: "d", name: "TAFE", segment: "x", is_montra: false },
] as never[];
let seq = 0;
const post = (brand: string, day: string, likes: number, extra: Record<string, unknown> = {}) => ({
  url: `u${++seq}`,
  brand,
  posted_at: `${day}T06:00:00Z`,
  text: "",
  theme: "Product",
  theme_manual: false,
  media: "image",
  image: null,
  likes,
  comments: 0,
  reposts: 0,
  as_of: today,
  ...extra,
});
const cmt = (id: string, posted_at: string, extra: Record<string, unknown> = {}) => ({
  id,
  post_url: "p1",
  brand: "m",
  parent: null,
  name: "LinkedIn member",
  headline: null,
  profile: null,
  page_reply: false,
  text: id,
  posted_at,
  reactions: 0,
  url: `https://x/${id}`,
  sentiment: "Negative",
  needs_response: true,
  handled: false,
  handled_by: null,
  ...extra,
});

test("weeks, previous period and median", () => {
  assert.deepEqual(weeksOf(customRange("2026-10-08", "2026-10-26", today)), [
    { from: "2026-10-08", to: "2026-10-12", partial: true },
    { from: "2026-10-13", to: "2026-10-19", partial: false },
    { from: "2026-10-20", to: "2026-10-26", partial: false },
  ]);
  assert.deepEqual(previousRange(customRange("2026-10-20", "2026-10-26", today)), {
    key: "custom",
    from: "2026-10-13",
    to: "2026-10-19",
  });
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.deepEqual(
    [fmtHours(0.25), fmtHours(3.25), fmtHours(30), fmtHours(60)],
    ["15 min", "3.3 h", "30 h", "2.5 days"],
  );
});

test("trend lines: followers at week end, posts per week, engagement rate, side averages", () => {
  const r = customRange("2026-10-13", "2026-10-26", today);
  const posts = [
    post("m", "2026-10-14", 100),
    post("m", "2026-10-21", 50),
    post("m", "2026-10-22", 150),
    post("c", "2026-10-15", 1000),
    post("d", "2026-10-15", 3000),
  ] as never[];
  const followers = [
    { brand: "m", date: "2026-10-12", followers: 10_000 },
    { brand: "m", date: "2026-10-25", followers: 10_100 },
    { brand: "c", date: "2026-10-12", followers: 100_000 },
    { brand: "d", date: "2026-10-12", followers: 300_000 },
  ];
  const t = trends(posts, brands, followers, r);
  const m = t.pages.find((s) => s.id === "m")!;
  assert.deepEqual(
    m.followers.map((p) => p.value),
    [10_000, 10_100],
  );
  assert.deepEqual(
    m.posts.map((p) => p.value),
    [1, 2],
  );
  assert.deepEqual(
    m.rate.map((p) => [p.value, p.low]),
    [
      [0.01, true],
      [100 / 10_100, true],
    ],
  );
  // Competitor average: followers averaged over pages, engagement rate over all their posts.
  assert.deepEqual(
    t.comp.followers.map((p) => p.value),
    [200_000, 200_000],
  );
  assert.deepEqual(
    t.comp.posts.map((p) => p.value),
    [1, 0],
  );
  assert.equal(t.comp.rate[0].value, 0.01);
  assert.equal(t.comp.rate[0].n, 2);
  assert.equal(t.comp.rate[1].value, null);
  assert.equal(trends(posts, brands, followers, r, "x").pages.length, 1);
  // A week before the first follower count still gets an engagement rate, from the first count.
  const late = trends(posts, brands, [{ brand: "m", date: "2026-10-25", followers: 10_000 }], r);
  assert.deepEqual(
    late.pages[0].followers.map((p) => p.value),
    [null, 10_000],
  );
  assert.equal(late.pages[0].rate[0].value, 0.01);
});

test("earned vs owned and media outlets", () => {
  const r = customRange("2026-10-20", "2026-10-26", today);
  const comments = [
    cmt("l1", "2026-10-21T06:00:00Z", {
      channel: "li_mention",
      media: true,
      name: "Autocar India",
      url: "https://li/1",
    }),
    cmt("l2", "2026-10-24T06:00:00Z", {
      channel: "li_mention",
      media: true,
      name: "Autocar India",
      url: "https://li/2",
    }),
    cmt("l3", "2026-10-24T06:00:00Z", { channel: "li_mention", media: false, name: "LinkedIn member" }), // a person: not earned media
    cmt("x1", "2026-10-22T06:00:00Z", { channel: "x", media: true, name: "EV News" }),
    cmt("x2", "2026-10-22T06:00:00Z", { channel: "x", media: true, page_reply: true, name: "Resonia" }),
    cmt("x3", "2026-10-02T06:00:00Z", { channel: "x", media: true, name: "EV News" }), // before the range
  ] as never[];
  const posts = [post("m", "2026-10-21", 1), post("m", "2026-10-25", 1), post("c", "2026-10-25", 1)] as never[];
  const xPosts = [
    {
      id: "1",
      url: "",
      posted_at: "2026-10-23T06:00:00Z",
      text: "",
      likes: 0,
      replies: 0,
      reposts: 0,
      quotes: 0,
      views: 1,
    },
  ];
  const e = earnedOwned(comments, posts, xPosts, brands, r);
  assert.deepEqual(e.total, { liMedia: 2, xMedia: 1, liPosts: 2, xPosts: 1 });
  assert.deepEqual(
    mediaOutlets(comments, r).map((o) => [o.name, o.channel, o.count, o.last.slice(0, 10), o.url]),
    [
      ["Autocar India", "LinkedIn", 2, "2026-10-24", "https://li/2"],
      ["EV News", "X", 1, "2026-10-22", "https://x/x1"],
    ],
  );
});

test("response times: first Resonia reply, slowest, unanswered after 24 and 48 hours", () => {
  const r = customRange("2026-10-20", "2026-10-26", today);
  const comments = [
    cmt("a", "2026-10-20T00:00:00Z"),
    cmt("ra1", "2026-10-20T02:00:00Z", { page_reply: true, parent: "a", needs_response: false }),
    cmt("ra2", "2026-10-20T01:00:00Z", { page_reply: true, parent: "a", needs_response: false }), // the first reply
    cmt("b", "2026-10-21T00:00:00Z"),
    cmt("rb", "2026-10-22T06:00:00Z", { page_reply: true, parent: "b", needs_response: false }),
    cmt("x:c", "2026-10-22T00:00:00Z", { channel: "x" }),
    cmt("x:rc", "2026-10-22T00:30:00Z", { channel: "x", page_reply: true, parent: "x:c", needs_response: false }),
    cmt("open1", "2026-10-25T00:00:00Z"), // 30 h waiting
    cmt("open2", "2026-10-23T00:00:00Z"), // 78 h waiting
    cmt("done", "2026-10-23T00:00:00Z", { handled: true }), // handled without a reply
    cmt("media", "2026-10-23T00:00:00Z", { channel: "x", media: true }), // media mentions are not counted
    cmt("mention", "2026-10-23T00:00:00Z", { channel: "li_mention" }),
    cmt("old", "2026-10-01T00:00:00Z"),
  ] as never[];
  const s = responseTimes(comments, r, "2026-10-26T06:00:00Z");
  assert.equal(s.items.length, 6);
  assert.deepEqual(
    s.answered.map((w) => [w.item.id, w.hours]),
    [
      ["a", 1],
      ["b", 30],
      ["x:c", 0.5],
    ],
  );
  assert.equal(s.avgHours, 31.5 / 3);
  assert.equal(s.medianHours, 1);
  assert.deepEqual(
    s.slowest.map((w) => w.item.id),
    ["b", "a", "x:c"],
  );
  assert.deepEqual([s.over24, s.over48, s.handledNoReply, s.low], [2, 1, 1, true]);
});

test("growth curves: snapshots by day after posting, average curve and the 80% day", () => {
  assert.deepEqual(
    growthCurve("2026-10-20T20:00:00Z", [
      // 21 Oct 01:30 IST: day 0 is 21 Oct
      { date: "2026-10-21", likes: 5, comments: 0 },
      { date: "2026-10-22", likes: 8, comments: 2 },
      { date: "2026-10-28", likes: 20, comments: 0 },
    ]),
    [5, 10, null, null, null, null, null, 20],
  );
  const curve = (g: (number | null)[]) => g;
  const posts = [
    post("m", "2026-10-01", 0, { growth: curve([10, 50, 70, 80, 85, 90, 95, 100]) }),
    post("m", "2026-10-02", 0, { growth: curve([20, 60, 70, 85, 90, 95, 98, 100]) }),
    post("m", "2026-10-03", 0, { growth: curve([5, 20, null, null, null, null, null, null]) }), // no day 7
    post("c", "2026-10-03", 0, { growth: curve([null, null, null, null, null, null, null, null]) }),
  ] as never[];
  const g = growthStats(posts, brands);
  assert.deepEqual(
    g.montra.points.map((p) => [p.day, p.avg, p.n, p.low]),
    [
      [1, 130 / 3, 3, true],
      [3, 82.5, 2, true],
      [7, 100, 2, true],
    ],
  );
  assert.equal(g.montra.n7, 2);
  assert.equal(g.montra.eightyDay, 3); // day 2: 70%, day 3: 82.5%
  assert.equal(g.comp.eightyDay, null);
  assert.equal(g.comp.points[0].n, 0);
});
