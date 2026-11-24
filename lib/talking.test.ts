import assert from "node:assert/strict";
import { test } from "node:test";
import { tagItem } from "./radar";
import { BRIEF_INSTRUCTION, weekly, weeklyBrief } from "./talking";

const brands = [
  { id: "m", name: "Resonia", is_montra: true },
  { id: "a", name: "Comp A", is_montra: false },
  { id: "b", name: "Comp B", is_montra: false },
] as never[];
let n = 0;
const post = (brand: string, day: string, likes: number, theme: string, text = "Post text — with a dash") =>
  ({
    url: `https://li/${++n}`,
    brand,
    posted_at: `${day}T06:00:00Z`,
    likes,
    comments: 0,
    reposts: 0,
    theme,
    media: "image",
    text,
    image: null,
  }) as never;
const posts = [
  post("a", "2026-10-06", 300, "Events & expos"),
  post("a", "2026-09-20", 100, "Product"),
  post("a", "2026-09-10", 50, "Product"),
  post("b", "2026-10-05", 40, "Product"),
  post("b", "2026-09-20", 40, "Product"),
  post("b", "2026-09-12", 40, "Leadership"),
  post("m", "2026-10-04", 10, "Product"),
];
const radar = [
  {
    url: "https://r/1",
    title: "Govt notifies PM E-DRIVE guidelines for electric trucks",
    source: "ET",
    snippet: null,
    published_at: "2026-10-06T04:30:00Z",
    query: "PM E-DRIVE",
    note: "Truck buyers get a subsidy",
  },
  {
    url: "https://r/2",
    title: "Some medium story about cars",
    source: "X",
    snippet: null,
    published_at: "2026-10-06T04:30:00Z",
    query: "q",
  },
  {
    url: "https://r/3",
    title: "Old policy scheme news",
    source: "Y",
    snippet: null,
    published_at: "2026-09-01T04:30:00Z",
    query: "q",
  },
].map((r) => ({ ...r, ...tagItem(r) }));

test("weekly talking points: best competitor posts, theme gaps, high radar", () => {
  const w = weekly({ posts, brands, radar, to: "2026-10-07" });
  assert.equal(w.label, "1 Oct to 7 Oct");
  assert.deepEqual(
    w.top.map((c) => [c.brand.id, Math.round(c.multiple * 100) / 100]),
    [
      ["a", 2],
      ["b", 1],
    ],
  );
  assert.deepEqual(
    w.gaps.map((g) => [g.theme, g.posts, g.pages]),
    [["Events & expos", 1, ["Comp A"]]],
  );
  assert.deepEqual(
    w.radar.map((r) => r.url),
    ["https://r/1"],
  );
  const brief = weeklyBrief(w, { notes: true });
  assert.ok(brief.startsWith(`${BRIEF_INSTRUCTION}\n\nWEEKLY BRIEF, 1 Oct to 7 Oct\n`));
  assert.match(
    brief,
    /1\. Comp A, 6 Oct, theme: Events & expos, format: Image\n {3}"Post text - with a dash"\n {3}300 likes \+ comments, 2\.0x the page average \(150\)/,
  );
  assert.match(
    brief,
    /- Events & expos: 1 competitor post \(Comp A\)\. Best: Comp A, 2\.0x page average, https:\/\/li\/1/,
  );
  assert.match(
    brief,
    /- Govt notifies PM E-DRIVE guidelines for electric trucks \(ET, 6 Oct\)\. Policy; Truck, SCV & 3W, Tractor, Corporate\. https:\/\/r\/1\n {2}Why it matters: Truck buyers get a subsidy/,
  );
  assert.doesNotMatch(brief, /[—–]/);
  assert.doesNotMatch(weeklyBrief(w), /Why it matters/);
});
