import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bestSlots,
  flagOf,
  fmtSlot,
  formatOf,
  formatPerf,
  hashtagStats,
  hashtags,
  highlights,
  insightRows,
  istSlot,
  launchKeywords,
  themePerf,
  timeGrid,
} from "./insights";
import { customRange } from "./range";

const brands = [
  { id: "m", name: "Resonia SCV", segment: "facebook", is_montra: true },
  { id: "c", name: "Euler Motors", segment: "facebook", is_montra: false },
  { id: "t", name: "TAFE", segment: "x", is_montra: false },
] as never[];
let seq = 0;
const post = (brand: string, posted_at: string, likes: number, extra: Record<string, unknown> = {}) => ({
  url: `u${++seq}`,
  brand,
  posted_at,
  text: "",
  theme: "Product",
  theme_manual: false,
  media: "image",
  image: null,
  likes,
  comments: 0,
  reposts: 0,
  as_of: "2026-10-06",
  ...extra,
});
const followers = [
  { brand: "m", date: "2026-10-01", followers: 1000 },
  { brand: "c", date: "2026-10-01", followers: 10_000 },
  { brand: "t", date: "2026-10-01", followers: 100_000 },
];
const range = customRange("2026-10-01", "2026-10-06", "2026-10-06");

test("best time: IST day and hour, grid averages, best slots prefer enough data", () => {
  assert.deepEqual(istSlot("2026-10-05T04:30:00Z"), { day: 0, hour: 10 }); // Mon 10:00 IST
  assert.deepEqual(istSlot("2026-10-04T19:00:00Z"), { day: 0, hour: 0 }); // Sun 19:00 UTC = Mon 00:30 IST
  const posts = [
    ...[10, 20, 30, 40, 50].map((l) => post("m", "2026-10-05T04:30:00Z", l)), // Mon 10am: 5 posts, avg 30
    post("m", "2026-10-06T06:30:00Z", 500), // Tue 12pm: one big post (low data)
    post("m", "2026-10-02T11:30:00Z", 5), // Fri 5pm
  ] as never[];
  const rows = insightRows(posts, brands, followers, range);
  const grid = timeGrid(rows);
  assert.equal(grid[0][10].n, 5);
  assert.equal(grid[0][10].avg, 30);
  assert.equal(grid[0][10].low, false);
  assert.equal(grid[1][12].low, true);
  const best = bestSlots(grid);
  assert.deepEqual(
    best.map((s) => [fmtSlot(s), s.low]),
    [
      ["Mon 10am–11am", false],
      ["Tue 12pm–1pm", true],
      ["Fri 5pm–6pm", true],
    ],
  );
});

test("format performance: carousels with documents, Resonia vs competitors, per page", () => {
  assert.equal(formatOf("carousel"), "Document/carousel");
  assert.equal(formatOf("document"), "Document/carousel");
  assert.equal(formatOf("article"), "Text");
  const posts = [
    post("m", "2026-10-02T06:00:00Z", 100, { media: "video" }),
    post("m", "2026-10-02T06:00:00Z", 20),
    post("c", "2026-10-02T06:00:00Z", 1000, { media: "carousel" }),
    post("c", "2026-10-03T06:00:00Z", 3000, { media: "document" }),
  ] as never[];
  const f = formatPerf(insightRows(posts, brands, followers, range));
  const video = f.overall.find((x) => x.key === "Video")!;
  assert.deepEqual([video.montra.n, video.montra.avg, video.montra.rate, video.montra.low], [1, 100, 0.1, true]);
  const docs = f.overall.find((x) => x.key === "Document/carousel")!;
  assert.deepEqual([docs.comp.n, docs.comp.avg, docs.comp.rate], [2, 2000, 0.2]);
  assert.equal(f.overall.find((x) => x.key === "Text")!.montra.avg, null);
  const montra = f.pages.find((p) => p.brand.id === "m")!;
  assert.equal(montra.byFormat.get("Image")!.avg, 20);
  assert.equal(montra.all.n, 2);
});

test("theme performance flags over- and under-performers, never on low data", () => {
  const posts = [
    ...[1, 2, 3, 4, 5].map(() => post("m", "2026-10-02T06:00:00Z", 100, { theme: "Product" })),
    ...[1, 2, 3, 4, 5].map(() => post("m", "2026-10-03T06:00:00Z", 20, { theme: "Hiring & culture" })),
    post("m", "2026-10-03T06:00:00Z", 1000, { theme: "Other" }),
  ] as never[];
  const t = themePerf(insightRows(posts, brands, followers, range), [
    "Product",
    "Hiring & culture",
    "Other",
    "Leadership",
  ]);
  assert.deepEqual(
    t.themes.map((x) => [x.key, x.montraFlag]),
    [
      ["Product", "under"], // 100 vs average (500 + 100 + 1000) / 11 ≈ 145
      ["Hiring & culture", "under"],
      ["Other", null], // one post: low data
    ],
  );
  assert.equal(
    flagOf(
      { n: 6, avg: 200, rate: null, low: false, partial: false },
      { n: 20, avg: 100, rate: null, low: false, partial: false },
    ),
    "over",
  );
  assert.equal(
    flagOf(
      { n: 6, avg: 110, rate: null, low: false, partial: false },
      { n: 20, avg: 100, rate: null, low: false, partial: false },
    ),
    null,
  );
});

test("hashtags: parsed once per post, counted per page and overall", () => {
  assert.deepEqual(hashtags("Go #EV #ev hashtag#CleanMobility #2026 a#b #Montra_Electric"), [
    "ev",
    "cleanmobility",
    "montra_electric",
  ]);
  const posts = [
    post("m", "2026-10-02T06:00:00Z", 10, { text: "#EV #Resonia" }),
    post("m", "2026-10-03T06:00:00Z", 30, { text: "#ev" }),
    post("c", "2026-10-03T06:00:00Z", 50, { text: "#EV #Euler" }),
  ] as never[];
  const h = hashtagStats(insightRows(posts, brands, followers, range));
  assert.deepEqual(
    h.overall.map((t) => [t.tag, t.uses, t.pages, t.avg, t.low]),
    [
      ["ev", 3, 2, 30, true],
      ["euler", 1, 1, 50, true],
      ["resonia", 1, 1, 10, true],
    ],
  );
  assert.deepEqual(
    h.perPage.get("m")!.map((t) => [t.tag, t.uses]),
    [
      ["ev", 2],
      ["resonia", 1],
    ],
  );
});

test("highlights: volume, spike, launch keywords and follower jumps", () => {
  assert.deepEqual(launchKeywords("We commissioned the line after being awarded the project; it was acquired in May."), [
    "commission",
    "awarded",
    "acquire",
  ]);
  assert.deepEqual(launchKeywords("A wonderful moment, recommissioning nothing"), []);
  const day = (d: string) => `${d}T06:00:00Z`;
  const r = customRange("2026-10-20", "2026-10-26", "2026-10-26");
  const posts = [
    // Euler: 1 post a week in the 4 weeks before, 4 in the last week, one of them a launch and a spike.
    ...["2026-09-24", "2026-10-01", "2026-10-08", "2026-10-15"].map((d) => post("c", day(d), 10)),
    post("c", day("2026-10-20"), 10),
    post("c", day("2026-10-21"), 10),
    post("c", day("2026-10-22"), 10),
    post("c", day("2026-10-24"), 200, { text: "Euler wins a project and commissioned a line today." }),
    // Resonia: a launch word, but Resonia posts are never launch callouts.
    post("m", day("2026-10-24"), 5, { text: "We launch today" }),
  ] as never[];
  const fol = [
    { brand: "t", date: "2026-10-18", followers: 100_000 },
    { brand: "t", date: "2026-10-26", followers: 101_500 },
    { brand: "c", date: "2026-10-18", followers: 10_000 },
    { brand: "c", date: "2026-10-26", followers: 10_050 }, // +0.5%: no callout
  ];
  const h = highlights({ posts, brands, followers: fol, range: r, segment: "all", trackingSince: "2026-09-20" });
  assert.deepEqual(
    h.map((x) => [x.kind, x.brand.id, x.date]),
    [
      ["volume", "c", "2026-10-26"],
      ["followers", "t", "2026-10-26"],
      ["launch", "c", "2026-10-24"],
      ["spike", "c", "2026-10-24"],
    ],
  );
  assert.match(
    h[0].text,
    /Euler Motors posted 4 times in the 7 days to 26 Oct, 4\.0× its usual 1\.0 a week \(low data\)/,
  );
  assert.match(h[1].text, /TAFE gained 1,500 followers \(1\.5%\) in the week to 26 Oct/);
  assert.match(h[2].text, /“commission”, “wins”/);
  assert.equal(h[2].url, h[3].url);
  // Too little history since tracking started: no volume callout.
  const fresh = highlights({ posts, brands, followers: [], range: r, segment: "all", trackingSince: "2026-10-22" });
  assert.equal(fresh.filter((x) => x.kind === "volume").length, 0);
  // The segment filter applies.
  assert.deepEqual(
    highlights({ posts, brands, followers: fol, range: r, segment: "x", trackingSince: null }).map((x) => x.kind),
    ["followers"],
  );
});

test("posts from a LinkedIn export: left out of best time, 'partial text' when most of a result", () => {
  const exp = (likes: number, text: string) =>
    post("m", "2026-10-02T06:30:00Z", likes, { origin: "export", text, theme: "Product" });
  const posts = [
    post("m", "2026-10-02T06:30:00Z", 10, { text: "#EV launch", theme: "Product" }),
    exp(500, "#EV opening text"),
    exp(300, "#EV more"),
  ] as never[];
  const rows = insightRows(posts, brands, followers, range);
  assert.equal(timeGrid(rows)[4][12].n, 1); // Fri 12pm: only the synced post
  const t = themePerf(rows, ["Product"]).themes[0];
  assert.deepEqual([t.montra.n, t.montra.partial], [3, true]);
  const tag = hashtagStats(rows).overall.find((x) => x.tag === "ev")!;
  assert.deepEqual([tag.uses, tag.partial], [3, true]);
  assert.equal(hashtagStats(rows).overall.find((x) => x.tag === "ev")!.avg, 270);
  const half = insightRows([posts[0], posts[1]], brands, followers, range);
  assert.equal(themePerf(half, ["Product"]).themes[0].montra.partial, false); // half is not "mostly"
});
