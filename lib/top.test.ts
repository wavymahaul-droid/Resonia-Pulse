import assert from "node:assert/strict";
import { test } from "node:test";
import { customRange } from "./range";
import { followersAt, topByPage, topCsv, topPagesText, topPosts, topText, topXPosts } from "./top";

const brands = [
  { id: "montra-scv", name: "Resonia SCV", segment: "facebook", is_montra: true },
  { id: "montra-tractor", name: "Resonia Tractor", segment: "x", is_montra: true },
  { id: "euler", name: "Euler Motors", segment: "facebook", is_montra: false },
  { id: "tafe", name: "TAFE", segment: "x", is_montra: false },
] as never[];
const post = (url: string, brand: string, day: string, likes: number, comments: number, reposts = 0) => ({
  url,
  brand,
  posted_at: `${day}T06:00:00Z`,
  text: `Post ${url}`,
  theme: "Product",
  theme_manual: false,
  media: "image",
  image: null,
  likes,
  comments,
  reposts,
  as_of: "2026-10-06",
});
const posts = [
  post("m1", "montra-scv", "2026-10-02", 50, 5),
  post("m2", "montra-tractor", "2026-10-03", 30, 2),
  post("m3", "montra-scv", "2026-09-20", 500, 50), // outside the range
  post("c1", "euler", "2026-10-04", 100, 10, 4),
  post("c2", "tafe", "2026-10-05", 400, 20),
] as never[];
const followers = [
  { brand: "montra-scv", date: "2026-10-01", followers: 1000 },
  { brand: "montra-tractor", date: "2026-10-01", followers: 100 },
  { brand: "euler", date: "2026-10-01", followers: 50_000 },
  { brand: "tafe", date: "2026-10-01", followers: 300_000 },
  { brand: "tafe", date: "2026-10-07", followers: 0 }, // after the range, and 0 is never a real count
];
const range = customRange("2026-10-01", "2026-10-06", "2026-10-06");

test("top posts: ranked by likes + comments or by engagement rate, within the range", () => {
  assert.equal(followersAt(followers, range.to).get("tafe"), 300_000);
  const a = topPosts(posts, brands, followers, range);
  assert.deepEqual(
    a.montra.map((r) => r.post.url),
    ["m1", "m2"],
  );
  assert.deepEqual(
    a.competitors.map((r) => r.post.url),
    ["c2", "c1"],
  );
  assert.equal(a.montra[0].rate, 55 / 1000);
  const b = topPosts(posts, brands, followers, range, { by: "rate" });
  assert.deepEqual(
    b.montra.map((r) => r.post.url),
    ["m2", "m1"],
  ); // 32/100 beats 55/1000
  assert.deepEqual(
    b.competitors.map((r) => r.post.url),
    ["c1", "c2"],
  ); // 110/50k beats 420/300k
  const tractors = topPosts(posts, brands, followers, range, { segment: "x" });
  assert.deepEqual(
    [tractors.montra.map((r) => r.post.url), tractors.competitors.map((r) => r.post.url)],
    [["m2"], ["c2"]],
  );
  assert.equal(topPosts(posts, brands, followers, range, { n: 1 }).montra.length, 1);
});

test("top X posts by views, copy text and CSV", () => {
  const x = [
    {
      id: "1",
      url: "https://x.com/MontraElectric/status/1",
      posted_at: "2026-10-02T05:00:00Z",
      text: "A",
      likes: 9,
      replies: 1,
      reposts: 0,
      quotes: 0,
      views: 100,
    },
    {
      id: "2",
      url: "https://x.com/MontraElectric/status/2",
      posted_at: "2026-10-03T05:00:00Z",
      text: "B",
      likes: 1,
      replies: 0,
      reposts: 2,
      quotes: 0,
      views: 900,
    },
    {
      id: "3",
      url: "https://x.com/MontraElectric/status/3",
      posted_at: "2026-10-04T05:00:00Z",
      text: "C",
      likes: 3,
      replies: 0,
      reposts: 0,
      quotes: 0,
      views: null,
    },
    {
      id: "4",
      url: "https://x.com/MontraElectric/status/4",
      posted_at: "2026-09-01T05:00:00Z",
      text: "D",
      likes: 99,
      replies: 0,
      reposts: 0,
      quotes: 0,
      views: 9999,
    },
  ];
  // Resonia impressions and CTR from an uploaded LinkedIn export show in the text and CSV.
  const withLi = [
    { ...(posts[0] as object), li: { impressions: 5432, clicks: 87, ctr: 0.016, reactions: 50 } },
    ...posts.slice(1),
  ] as never[];
  const liText = topText(topPosts(withLi, brands, followers, range), null, {
    label: "x",
    by: "engagement",
    segmentLabel: "All",
    handle: "MontraElectric",
  });
  assert.match(
    liText,
    /0 reposts, 5\.50% follower engagement rate, 5,432 impressions, 1\.60% CTR, 137 engagements, — LinkedIn engagement rate \(LinkedIn export\)\n {3}m1/,
  );
  assert.match(
    topCsv(topPosts(withLi, brands, followers, range), null, "M"),
    /Resonia,1,.*,0\.055000,5432,0\.016000,137,,no,55,,,m1/,
  );
  const tx = topXPosts(x, range);
  assert.deepEqual(
    tx.map((p) => p.id),
    ["2", "1", "3"],
  );
  const top = topPosts(posts, brands, followers, range);
  const text = topText(top, tx, {
    label: "1–6 Oct 2026",
    by: "engagement",
    segmentLabel: "All",
    handle: "MontraElectric",
  });
  assert.match(text, /^Resonia top posts, 1–6 Oct 2026\nRanked by likes \+ comments\n/);
  assert.match(
    text,
    /1\. Resonia SCV · 2 Oct 2026 · Product: "Post m1"\n   50 likes, 5 comments, 0 reposts, 5\.50% follower engagement rate\n   m1/,
  );
  assert.match(
    text,
    /X @MontraElectric \(by views\):\n1\. 3 Oct 2026: "B"\n   900 views, 1 like, 0 replies, 2 reposts\n   https:\/\/x\.com\/MontraElectric\/status\/2/,
  );
  assert.match(text, /views not reported/);
  const empty = topText({ montra: [], competitors: [] }, null, {
    label: "6 Oct 2026",
    by: "rate",
    segmentLabel: "Tractors",
    handle: "MontraElectric",
  });
  assert.match(empty, /Ranked by engagement rate .* · Tractors/);
  assert.match(empty, /Resonia:\n- No posts in this period/);
  assert.doesNotMatch(empty, /X @/);
  const csv = topCsv(top, tx, "MontraElectric").replace(/^﻿/, "").split("\r\n");
  assert.equal(csv.length, 1 + 2 + 2 + 3);
  assert.equal(csv[1], "Resonia,1,Resonia SCV,2026-10-02,Product,50,5,0,0.055000,,,,,,55,,,m1,Post m1");
  assert.equal(csv[5], "X,1,X @MontraElectric,2026-10-03,,1,,2,,,,,,,,900,0,https://x.com/MontraElectric/status/2,B");
});

test("top posts by page: one block per page, empty pages kept, single page and grouped text", () => {
  const extra = [
    ...(posts as unknown as ReturnType<typeof post>[]),
    ...[1, 2, 3, 4, 5, 6].map((i) => post(`e${i}`, "euler", "2026-10-02", i * 10, 0)),
  ] as never[];
  const t = topByPage(extra, brands, followers, range);
  assert.deepEqual(
    t.montra.map((p) => [p.brand.id, p.list.map((r) => r.post.url)]),
    [
      ["montra-scv", ["m1"]],
      ["montra-tractor", ["m2"]],
    ],
  );
  assert.deepEqual(
    t.competitors.map((p) => [p.brand.id, p.list.map((r) => r.post.url)]),
    [
      ["euler", ["c1", "e6", "e5", "e4", "e3"]], // top 5 of 7
      ["tafe", ["c2"]],
    ],
  );
  const scv = topByPage(extra, brands, followers, customRange("2026-10-06", "2026-10-06", "2026-10-06"), {
    segment: "facebook",
  });
  assert.deepEqual(
    [...scv.montra, ...scv.competitors].map((p) => [p.brand.id, p.list.length]),
    [
      ["montra-scv", 0],
      ["euler", 0],
    ],
  );
  const opts = { label: "1–6 Oct 2026", by: "engagement" as const, segmentLabel: "All", handle: "MontraElectric" };
  const text = topPagesText(t, [], opts);
  assert.match(text, /^Resonia top posts by page, 1–6 Oct 2026\n/);
  assert.match(text, /== Resonia ==\n\nResonia SCV:\n1\. 2 Oct 2026 · Product: "Post m1"/);
  assert.match(text, /== Competitors ==\n\nEuler Motors:\n1\. 4 Oct 2026 · Product: "Post c1"/);
  assert.match(text, /X @MontraElectric \(by views\):\n- No posts in this period/);
  const empty = topPagesText(scv, null, { ...opts, segmentLabel: "SCV & 3W" });
  assert.match(empty, /Ranked by likes \+ comments · SCV & 3W/);
  assert.match(empty, /Resonia SCV:\n- No posts in this period/);
  const one = topPagesText({ montra: [], competitors: [t.competitors[1]] }, [], opts);
  assert.match(one, /^TAFE top posts, 1–6 Oct 2026\nRanked by likes \+ comments\n\nTAFE:\n1\. 5 Oct 2026/);
  assert.doesNotMatch(one, /==|X @/);
  const csv = topCsv(t, null, "MontraElectric")
    .replace(/^\uFEFF/, "")
    .split("\r\n");
  assert.equal(csv.length, 1 + 2 + 6);
  assert.match(csv[3], /^Competitors,1,Euler Motors,2026-10-04,.*,not public,not public,/);
  assert.match(csv[8], /^Competitors,1,TAFE,/); // rank restarts per page
});
