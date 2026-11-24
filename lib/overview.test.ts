import assert from "node:assert/strict";
import { test } from "node:test";
import { customRange } from "./range";
import {
  dailyEngagement,
  overviewTiles,
  pageAverages,
  sovSlices,
  standouts,
  themeShares,
  todaysSignals,
} from "./overview";

const brands = [
  { id: "m1", name: "Resonia", is_montra: true },
  { id: "m2", name: "Resonia SCV", is_montra: true },
  ...["a", "b", "c", "d", "e", "f", "g"].map((x) => ({ id: x, name: `Comp ${x.toUpperCase()}`, is_montra: false })),
] as never[];
let n = 0;
const post = (brand: string, day: string, likes: number, theme = "Product") =>
  ({
    url: `u${++n}`,
    brand,
    posted_at: `${day}T06:00:00Z`,
    likes,
    comments: 0,
    reposts: 0,
    theme,
    media: "image",
    text: "",
    image: null,
  }) as never;
const range = customRange("2026-09-08", "2026-10-07", "2026-10-07");
const posts = [
  post("m1", "2026-10-06", 300), // this week, 3x page average
  post("m1", "2026-09-20", 50),
  post("m1", "2026-09-10", 50),
  post("m1", "2026-08-20", 0),
  post("m2", "2026-09-15", 10, "Hiring"),
  ...["a", "b", "c", "d", "e", "f", "g"].map((x, i) =>
    post(x, "2026-09-12", 100 + i * 10, i % 2 ? "Hiring" : "Product"),
  ),
];

test("share of voice: Resonia combined, top 5 competitors, others", () => {
  const s = sovSlices(posts, brands, range);
  assert.deepEqual(
    s.map((x) => [x.name, x.value, x.kind]),
    [
      ["Resonia (all pages)", 410, "montra"],
      ["Comp G", 160, "comp"],
      ["Comp F", 150, "comp"],
      ["Comp E", 140, "comp"],
      ["Comp D", 130, "comp"],
      ["Comp C", 120, "comp"],
      ["Others", 210, "others"],
    ],
  );
  assert.equal(Math.round(s.reduce((a, x) => a + x.share, 0) * 1e9), 1e9);
});

test("page averages, theme shares and the daily line", () => {
  const avg = pageAverages(posts, brands, range);
  assert.deepEqual([avg[0].name, avg[0].avg, avg.at(-1)!.name], ["Comp G", 160, "Resonia SCV"]);
  assert.ok(avg.every((r, i) => i === 0 || r.avg <= avg[i - 1].avg));
  assert.equal(avg.find((r) => r.id === "m1")!.avg, 400 / 3);
  const th = themeShares(posts, brands, range);
  const product = th.find((t) => t.theme === "Product")!;
  assert.deepEqual([product.montra, product.comp], [3 / 4, 4 / 7]);
  const d = dailyEngagement(posts, brands, range.to);
  assert.equal(d.length, 30);
  assert.deepEqual(
    d.find((x) => x.date === "2026-10-06"),
    { date: "2026-10-06", montra: 150, comp: 0 },
  );
});

test("standouts, signals and tiles", () => {
  const st = standouts(posts, brands, range);
  assert.deepEqual([st[0].brand.id, st[0].multiple], ["m1", 300 / 100]);
  const sig = todaysSignals({
    posts,
    brands,
    comments: [{ needs_response: true, handled: false, posted_at: "2026-10-04T06:00:00Z" }] as never,
    range,
    today: "2026-10-07",
    trackingSince: "2026-10-05",
  });
  assert.equal(sig.length, 3);
  assert.deepEqual(
    sig.map((s) => s.alert),
    [true, true, false],
  );
  assert.match(sig[0].text, /^1 comment or mention needs a response \(oldest 3 days old\)/);
  assert.match(sig[1].text, /^Resonia SCV hasn't posted for 22 days/);
  assert.match(sig[2].text, /Resonia's 6 Oct post got 3\.0× its page average/);
  const li = {
    ready: true,
    split: true,
    lastUploaded: "2026-10-07T00:00:00Z",
    pages: [
      {
        brand: "m1",
        date: "2026-09-20",
        impressions: 1000,
        impressions_organic: 900,
        clicks: 10,
        clicks_organic: 9,
        new_followers: 5,
        page_views: null,
        unique_visitors: null,
      },
    ],
  } as never;
  const tiles = overviewTiles({ li, posts, brands, range, today: "2026-10-07" });
  assert.deepEqual(
    tiles.map((t) => [t.key, t.value, t.noPrev]),
    [
      ["impressions", 900, true],
      ["engagements", 9, true],
      ["followers", 5, true],
      ["sov", 410 / 1320, false], // posts backfilled to 24 May, so the previous period compares
      ["pace", 2, false],
    ],
  );
  // Posting pace: Resonia 4 posts on 2 pages vs 7 competitor posts on 7 pages.
  assert.equal(tiles[4].valueText, "2.0 vs 1.0");
  assert.equal(tiles[4].spark.at(-1)!.v, 0.5); // 1 Resonia post in the 7 days to 7 Oct, per page
  assert.deepEqual([tiles[0].lastExport, tiles[0].stale], ["2026-09-20", true]);
  assert.equal(tiles[0].spark.length, 30);
});

test("public view: no 'hasn't posted' signal, still three; organic tile labels", () => {
  const sig = todaysSignals({
    posts,
    brands,
    comments: [{ needs_response: true, handled: false, posted_at: "2026-10-04T06:00:00Z" }] as never,
    range,
    today: "2026-10-07",
    trackingSince: "2026-10-05",
    showQuiet: false,
  });
  assert.equal(sig.length, 3);
  assert.ok(sig.every((s) => !/hasn't posted/.test(s.text)));
  assert.match(sig[1].text, /3\.0× its page average/);
  assert.match(sig[2].text, /^Comp G leads share of voice this period \(12\.1%\)/);
  const tiles = overviewTiles({
    li: { ready: true, split: true, lastUploaded: null, pages: [] } as never,
    posts,
    brands,
    range,
    today: "2026-10-07",
  });
  assert.deepEqual(
    tiles.map((t) => [t.label, !!t.tip]),
    [
      ["Organic impressions", true],
      ["Organic engagements", true],
      ["Resonia new followers", false],
      ["Resonia share of voice", false],
      ["Posting pace", false],
    ],
  );
});

test("new followers tile: total followers per Resonia page, with the first count after the period", () => {
  const tiles = overviewTiles({
    li: { ready: true, split: true, lastUploaded: null, pages: [] } as never,
    posts,
    brands: [
      { id: "m1", name: "Resonia", is_montra: true, segment: "linkedin" },
      { id: "m2", name: "Resonia SCV", is_montra: true, segment: "facebook" },
    ] as never,
    range,
    today: "2026-10-07",
    followers: [
      { brand: "m1", date: "2026-10-05", followers: 88796 },
      { brand: "m2", date: "2026-10-05", followers: 65001 },
      { brand: "m1", date: "2026-10-06", followers: 88829 },
    ],
  });
  const f = tiles.find((t) => t.key === "followers")!;
  assert.deepEqual(f.extra, {
    line: "Total followers: 1,53,830",
    pages: "LinkedIn 88.8K · Facebook 65.0K",
    tip: "Scraped counts on 7 Oct or the last day before",
  });
});
