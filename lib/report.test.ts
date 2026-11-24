import assert from "node:assert/strict";
import { test } from "node:test";
import { customRange } from "./range";
import { buildReport, fmtChange, reportCsv, reportText, trendOf } from "./report";

const brands = [
  { id: "montraelectric", name: "Resonia", segment: "linkedin", is_montra: true, track_comments: true },
  { id: "eulermotors", name: "Euler Motors", segment: "facebook", is_montra: false, track_comments: false },
];
let seq = 0;
const post = (brand: string, day: string, likes: number, comments = 0) => ({
  url: `https://li/p${++seq}`,
  brand,
  posted_at: `${day}T05:30:00Z`,
  text: `Post ${seq}`,
  theme: "Product",
  theme_manual: false,
  media: "image",
  image: null,
  likes,
  comments,
  reposts: 1,
  as_of: "2026-10-26",
});
const cmt = (id: string, posted_at: string, extra: Record<string, unknown> = {}) => ({
  id,
  post_url: "https://li/p1",
  brand: "montraelectric",
  parent: null,
  name: "LinkedIn member",
  headline: null,
  profile: null,
  page_reply: false,
  text: `comment ${id}`,
  posted_at,
  reactions: 0,
  url: null,
  sentiment: "Negative",
  needs_response: true,
  handled: false,
  handled_by: null,
  ...extra,
});

const data = {
  generatedAt: "2026-10-26T12:00:00Z",
  trackingSince: "2026-10-05",
  brands,
  posts: [
    post("montraelectric", "2026-10-21", 100, 10),
    post("montraelectric", "2026-10-22", 20),
    post("montraelectric", "2026-10-15", 40), // previous week
    post("eulermotors", "2026-10-23", 300, 30),
    post("eulermotors", "2026-10-16", 90),
  ],
  followers: [
    { brand: "montraelectric", date: "2026-10-12", followers: 10_000 },
    { brand: "montraelectric", date: "2026-10-19", followers: 10_200 },
    { brand: "montraelectric", date: "2026-10-26", followers: 10_500 },
    { brand: "eulermotors", date: "2026-10-12", followers: 50_000 },
  ],
  comments: [
    cmt("a", "2026-10-21T06:00:00Z"),
    cmt("ra", "2026-10-21T08:00:00Z", { page_reply: true, parent: "a", needs_response: false, sentiment: "Neutral" }),
    cmt("b", "2026-10-22T06:00:00Z", { sentiment: "Lead" }),
    cmt("c", "2026-10-16T06:00:00Z", { sentiment: "Positive", needs_response: false }),
    cmt("m1", "2026-10-24T06:00:00Z", {
      channel: "li_mention",
      media: true,
      needs_response: false,
      sentiment: "Neutral",
      name: "Autocar India",
      url: "https://li/m1",
    }),
  ],
  x: { ready: false, handle: "MontraElectric", profileUrl: "", posts: [], followers: [] },
  liExport: {
    ready: true,
    lastUploaded: "2026-10-26T09:00:00Z",
    pages: [
      // This week and the week before, Resonia only.
      {
        brand: "montraelectric",
        date: "2026-10-21",
        impressions: 3000,
        clicks: 60,
        new_followers: 7,
        page_views: 40,
        unique_visitors: 25,
      },
      {
        brand: "montraelectric",
        date: "2026-10-22",
        impressions: 1000,
        clicks: 20,
        new_followers: 3,
        page_views: 10,
        unique_visitors: 6,
      },
      {
        brand: "montraelectric",
        date: "2026-10-15",
        impressions: 2000,
        clicks: 20,
        new_followers: 2,
        page_views: 20,
        unique_visitors: 12,
      },
      // The rest of the week before, so it is fully covered.
      ...["13", "14", "16", "17", "18", "19"].map((d) => ({
        brand: "montraelectric",
        date: `2026-10-${d}`,
        impressions: 0,
        clicks: 0,
        new_followers: 0,
        page_views: 0,
        unique_visitors: 0,
      })),
    ],
  },
} as never;
// The first Resonia post has export numbers.
(data as { posts: { li?: unknown }[] }).posts[0].li = { impressions: 2500, clicks: 50, ctr: 0.02, reactions: 100 };

test("report: KPIs, ORM, earned vs owned and best time against the previous period", () => {
  const r = buildReport(data, customRange("2026-10-20", "2026-10-26", "2026-10-26"));
  assert.equal(r.prevLabel, "13–19 Oct 2026");
  const k = Object.fromEntries(r.kpis.map((m) => [m.label, m]));
  assert.deepEqual([k["Resonia posts"].now, k["Resonia posts"].prev], [2, 1]);
  assert.equal(fmtChange(k["Resonia posts"]), "+100%");
  assert.deepEqual([k["Resonia followers (all pages)"].now, k["Resonia follower growth"].now], [10_500, 300]);
  assert.equal(k["Follower engagement rate: Resonia ((likes + comments) ÷ followers)"].low, true);
  assert.equal(k["Resonia likes + comments"].now, 130);
  const o = Object.fromEntries(r.orm.metrics.map((m) => [m.label, m]));
  assert.deepEqual([o["New comments and X mentions"].now, o["New comments and X mentions"].prev], [2, 1]);
  assert.equal(o["Average response time"].now, 2);
  assert.equal(o["Average response time"].low, true);
  assert.equal(trendOf(o["Unanswered after 24 hours"]), "down"); // b has waited 4+ days
  assert.deepEqual(
    r.orm.sentiment.find((s) => s.name === "Negative"),
    { name: "Negative", now: 1, prev: 0 },
  );
  assert.deepEqual(
    r.earned.metrics.map((m) => m.now),
    [1, 0, 2, 0],
  );
  assert.equal(r.earned.outlets[0].name, "Autocar India");
  assert.deepEqual(
    r.top.montra.map((t) => t.post.likes),
    [100, 20],
  );
  assert.equal(r.bestTime[0].low, true);
  assert.equal(r.x.metrics.length, 0);
  const reach = Object.fromEntries(r.reach.metrics.map((m) => [m.label, m]));
  assert.equal(r.reach.label, "from LinkedIn export, last uploaded 26 Oct 2026");
  assert.deepEqual(
    [
      reach["Page impressions (all posts, daily totals)"].now,
      reach["Page impressions (all posts, daily totals)"].prev,
      reach["CTR (total clicks ÷ total impressions)"].now,
    ],
    [4000, 2000, 0.02],
  );
  assert.equal(fmtChange(reach["Page impressions (all posts, daily totals)"]), "+100%");
  assert.deepEqual([reach["New followers"].now, reach["Page views"].now], [10, 50]);
  assert.deepEqual([reach["Impressions per post"].now, reach["Impressions per post"].low], [2500, true]);
  // The one post with export numbers is an image, so CTR is the same with and without video.
  assert.deepEqual(
    [reach["CTR on those posts (with video)"].now, reach["CTR on those posts, without video posts"].now],
    [0.02, 0.02],
  );
});

test("report: copy text sections and CSV rows", () => {
  const r = buildReport(data, customRange("2026-10-20", "2026-10-26", "2026-10-26"));
  const text = reportText(r);
  assert.match(
    text,
    /^Resonia social media report, 20–26 Oct 2026\nCompared with the previous 13–19 Oct 2026, where there is comparable earlier data\n/,
  );
  for (const h of [
    "KEY NUMBERS",
    "HIGHLIGHTS",
    "TOP RESONIA POSTS",
    "TOP COMPETITOR POSTS",
    "REACH (RESONIA LINKEDIN PAGES)",
    "BEST TIME TO POST (RESONIA, IST)",
  ])
    assert.ok(text.includes(`\n\n${h}\n`), h);
  assert.doesNotMatch(text, /\nX \(@/); // X not set up in this data
  assert.match(
    text,
    /All \(organic \+ sponsored\) page totals from LinkedIn export, last uploaded 26 Oct 2026; every post on a Resonia feed is organic\. Video: LinkedIn counts plays as clicks, so CTR can exceed 100%\. Competitors' impressions and clicks are not public/,
  );
  assert.match(text, /- Page impressions \(all posts, daily totals\): 4,000 \(\+100% vs 2,000 in 13–19 Oct 2026\)/);
  assert.match(text, /- Resonia posts: 2 \(\+100% vs 1 in 13–19 Oct 2026\)/);
  assert.match(text, /- Follower engagement rate: Resonia \(\(likes \+ comments\) ÷ followers\): [\d.]+% \(low data\)/);
  assert.match(text, /1\. Resonia, 21 Oct 2026: "Post \d+"\n {3}100 likes, 10 comments, 1 repost/);
  assert.doesNotMatch(text, /- Media outlets:/); // no earned-media section without ORM
  const csv = reportCsv(r).replace(/^﻿/, "").split("\r\n");
  assert.equal(csv[0], "section,item,current,previous,change,low_data,link,note");
  assert.ok(csv.includes("KPIs,Resonia posts,2,1,+100%,,,"));
  assert.ok(csv.some((l) => l.startsWith('Media outlets,"Autocar India (LinkedIn), last 2026-10-24",1,')));
  assert.equal(fmtChange({ label: "", now: 0.012, prev: 0.01, format: "pct" }), "+0.20 pts");
  assert.equal(fmtChange({ label: "", now: 3, prev: 0, format: "int" }), "new");
});

test("report: no comparison where the previous period has little or no tracked data", () => {
  // 1–7 Oct: the week before is mostly before daily tracking (5 Oct) but after the post backfill
  // (1 Sep), so post figures compare and ORM, followers and reach do not.
  const r = buildReport(data, customRange("2026-10-01", "2026-10-07", "2026-10-26"));
  const k = Object.fromEntries(r.kpis.map((m) => [m.label, m]));
  assert.equal(k["Resonia posts"].noPrev, false);
  assert.equal(k["Resonia share of voice"].noPrev, false);
  assert.equal(k["Resonia follower growth"].noPrev, true); // first follower count 12 Oct
  assert.ok(r.orm.metrics.every((m) => m.noPrev && fmtChange(m) == null && trendOf(m) == null));
  assert.ok(r.orm.sentiment.every((s) => s.prev == null));
  assert.ok(r.reach.metrics.every((m) => m.noPrev));
  const text = reportText(r);
  // Resonia Pulse: no ORM section in the text (comments and mentions are not tracked).
  assert.doesNotMatch(text, /New comments and X mentions/);
  const csv = reportCsv(r)
    .replace(/^\uFEFF/, "")
    .split("\r\n");
  assert.ok(csv.some((l) => /^ORM,New comments and X mentions,\d+,,no comparable earlier data,/.test(l)));

  // August: before the backfill, so share of voice and post counts are not compared either.
  const aug = buildReport(data, customRange("2026-05-24", "2026-06-20", "2026-10-26"));
  const ka = Object.fromEntries(aug.kpis.map((m) => [m.label, m]));
  assert.ok(aug.kpis.every((m) => m.noPrev));
  assert.equal(fmtChange(ka["Resonia share of voice"]), null);
  assert.equal(aug.anyPrev, false);
  assert.match(
    reportText(aug),
    /^Resonia social media report, .*\nCompared with the previous .* \(no comparable earlier data\)\n/,
  );
  assert.match(reportText(aug), /- Resonia share of voice: .* \(no comparable earlier data\)/);
});
