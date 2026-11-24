import assert from "node:assert/strict";
import { test } from "node:test";
import * as XLSX from "@e965/xlsx";
import { matchPost, pageFromFileName, parseExport, toDate, toNumber, toRate } from "./liexport";

// Workbooks shaped like LinkedIn's exports: a description line above the column names.
function book(sheets: Record<string, unknown[][]>, bookType: XLSX.BookType): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: "buffer", bookType }) as Buffer;
}

const content = {
  Metrics: [
    ["Aggregated metrics for all posts by date, organic and sponsored"],
    [
      "Date",
      "Impressions (organic)",
      "Impressions (sponsored)",
      "Impressions (total)",
      "Unique impressions (organic)",
      "Clicks (organic)",
      "Clicks (sponsored)",
      "Clicks (total)",
      "Reactions (organic)",
      "Reactions (sponsored)",
      "Reactions (total)",
      "Comments (total)",
      "Reposts (total)",
      "Engagement rate (total)",
    ],
    ["10/01/2026", 1200, 300, 1500, 900, 40, 10, 50, 30, 5, 35, 4, 2, 0.061],
    ["10/02/2026", 800, 0, 800, 600, 16, 0, 16, 20, 0, 20, 1, 0, 0.046],
  ],
  "All posts": [
    ["All posts data, lifetime of each post"],
    [
      "Post title",
      "Post link",
      "Post type",
      "Campaign name",
      "Posted by",
      "Created date",
      "Campaign start date",
      "Campaign end date",
      "Audience",
      "Impressions",
      "Views (excluding off-site video views)",
      "Off-site views",
      "Clicks",
      "Click through rate (CTR)",
      "Likes",
      "Comments",
      "Reposts",
      "Follows",
      "Engagement rate",
      "Content Type",
    ],
    [
      "Another step forward in electrifying mid-mile logistics. Resonia has flagged off",
      "https://www.linkedin.com/feed/update/urn:li:activity:7512745907554205697",
      "Organic",
      "",
      "Resonia SCV",
      "10/05/2026",
      "",
      "",
      "All followers",
      "5,432",
      "",
      "",
      "87",
      "1.60%",
      "119",
      "2",
      "2",
      "",
      "3.82%",
      "Image",
    ],
    [
      "Gandhi Ji showed us that meaningful change begins with conscious choices.",
      "https://www.linkedin.com/feed/update/urn:li:ugcPost:7511639030000000000",
      "Organic",
      "",
      "Resonia",
      "10/02/2026",
      "",
      "",
      "All followers",
      2100,
      "",
      "",
      21,
      0.01,
      40,
      0,
      2,
      "",
      0.03,
      "Image",
    ],
    [
      "An old post the tracker never saw",
      "https://www.linkedin.com/feed/update/urn:li:share:7400000000000000000",
      "Organic",
      "",
      "Resonia",
      "08/01/2026",
      "",
      "",
      "",
      300,
      "",
      "",
      3,
      "",
      10,
      0,
      0,
      "",
      "",
      "Text",
    ],
  ],
};
const followers = {
  "New followers": [
    ["Date", "Sponsored followers", "Organic followers", "Auto-invited followers", "Total followers"],
    ["10/01/2026", 0, 12, 0, 12],
    ["10/02/2026", 3, 9, 0, 12],
  ],
  Location: [
    ["Location", "Total followers"],
    ["Chennai", 4000],
  ],
};
const visitors = {
  "Visitor metrics": [
    [
      "Date",
      "Overview page views (desktop)",
      "Overview page views (mobile)",
      "Overview page views (total)",
      "Total page views (desktop)",
      "Total page views (mobile)",
      "Total page views (total)",
      "Total unique visitors (desktop)",
      "Total unique visitors (mobile)",
      "Total unique visitors (total)",
    ],
    ["10/01/2026", 10, 20, 30, 15, 25, 40, 8, 14, 22],
  ],
};

test("values: numbers, rates and dates as LinkedIn writes them", () => {
  assert.deepEqual(
    [toNumber("5,432"), toNumber(12), toNumber(""), toNumber("n/a"), toNumber("1.6%")],
    [5432, 12, null, null, 0.016],
  );
  assert.deepEqual([toRate("1.60%"), toRate(0.016), toRate(1.6), toRate(null)], [0.016, 0.016, 0.016, null]);
  assert.equal(toDate("10/05/2026"), "2026-10-05"); // US month/day
  assert.equal(toDate("10/05/2026", true), "2026-05-10");
  assert.equal(toDate("25/10/2026"), "2026-10-25"); // only day-first makes sense
  assert.equal(toDate("2026-10-05"), "2026-10-05");
  assert.equal(toDate(46300), "2026-10-05"); // Excel serial
  assert.equal(toDate(new Date(2026, 9, 5)), "2026-10-05");
  assert.equal(toDate("Total"), null);
});

for (const type of ["xls", "xlsx"] as const) {
  test(`content export (.${type}): posts with impressions and CTR, daily metrics`, () => {
    const p = parseExport(book(content, type), `montra-electric-scv_content_1728000000000.${type}`);
    assert.deepEqual(p.kinds, ["content"]);
    assert.equal(p.posts.length, 3);
    const [a, b] = p.posts;
    assert.deepEqual(
      [a.ids, a.created, a.impressions, a.clicks, a.ctr, a.reactions, a.comments, a.reposts, a.engagementRate],
      [["7512745907554205697"], "2026-10-05", 5432, 87, 0.016, 119, 2, 2, 0.0382],
    );
    assert.deepEqual([b.ctr, b.impressions, b.ids], [0.01, 2100, ["7511639030000000000"]]);
    assert.equal(p.posts[2].ctr, 0.01); // no CTR column value: clicks ÷ impressions
    assert.deepEqual(p.daily[0], {
      date: "2026-10-01",
      impressions: 1500, // LinkedIn's total, sponsored included
      unique_impressions: 900,
      clicks: 50,
      reactions: 35,
      comments: 4,
      reposts: 2,
      engagement_rate: 0.061,
      // ...and the organic and sponsored parts, kept apart.
      impressions_organic: 1200,
      impressions_sponsored: 300,
      clicks_organic: 40,
      clicks_sponsored: 10,
      reactions_organic: 30,
      reactions_sponsored: 5,
    });
    // Post type, sponsored and the raw export row.
    assert.deepEqual(
      [a.postType, a.sponsored, a.raw["Impressions"], a.raw["Click through rate (CTR)"]],
      ["Organic", false, "5,432", "1.60%"],
    );
    assert.deepEqual([p.dateFrom, p.dateTo], ["2026-08-01", "2026-10-05"]);
  });
}

test("followers and visitors exports; demographics sheets skipped", () => {
  const f = parseExport(book(followers, "xls"), "f.xls");
  assert.deepEqual(f.kinds, ["followers"]);
  assert.deepEqual(f.daily[1], {
    date: "2026-10-02",
    new_followers_organic: 9,
    new_followers_sponsored: 3,
    new_followers: 12,
  });
  const v = parseExport(book(visitors, "xlsx"), "v.xlsx");
  assert.deepEqual(v.kinds, ["visitors"]);
  assert.deepEqual(v.daily, [{ date: "2026-10-01", page_views: 40, unique_visitors: 22 }]);
  // CSV, saved from Excel with day-first dates.
  const csv = Buffer.from(
    "Date,Sponsored followers,Organic followers,Total followers\n13/10/2026,0,5,5\n01/11/2026,1,2,3\n",
  );
  const c = parseExport(csv, "followers.csv");
  assert.deepEqual(
    c.daily.map((d) => [d.date, d.new_followers]),
    [
      ["2026-10-13", 5],
      ["2026-11-01", 3],
    ],
  );
  const junk = parseExport(Buffer.from("name,score\nA,1\n"), "other.csv");
  assert.deepEqual(junk.kinds, []);
  assert.match(junk.warnings[0], /does not look like a LinkedIn page analytics export/);
});

test("sponsored only when the export says so; ads are rows on no feed", async () => {
  const { hasFeedUrl, isAdRow, isSponsored, isVideoType } = await import("./liexport");
  assert.equal(isSponsored({ postType: "Sponsored" }), true);
  assert.equal(isSponsored({ postType: "Organic", campaign: "Diwali boost" }), true);
  // Numbers never decide: the 15 Sep 2026 row (4,266 impressions, 4,753 clicks) is organic.
  assert.equal(isSponsored({ postType: "Organic", campaign: "" }), false);
  assert.equal(isSponsored({ postType: null }), false);
  assert.equal(hasFeedUrl("https://www.linkedin.com/feed/update/urn:li:activity:7505614000000000000"), true);
  assert.equal(hasFeedUrl("https://www.linkedin.com/posts/montraelectric_x-activity-1-abcd"), true);
  assert.equal(hasFeedUrl("https://www.linkedin.com/campaignmanager/accounts/1"), false);
  assert.equal(
    isAdRow({ link: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7400000000000000000", sponsored: true }),
    true,
  );
  assert.equal(
    isAdRow({ link: "https://www.linkedin.com/feed/update/urn:li:ugcPost:7400000000000000000", sponsored: false }),
    false,
  );
  assert.equal(isAdRow({ link: "", sponsored: false }), true);
  assert.deepEqual([isVideoType("Video"), isVideoType("Image"), isVideoType(null)], [true, false, false]);
});

test("matching export rows to tracked posts and pages to file names", () => {
  const stored = [
    {
      post_url: "https://www.linkedin.com/posts/montra-electric-scv_x-activity-7512745907554205697-pqSM",
      brand_id: "montra-electric-scv",
      linkedin_id: "7512745907554205697",
      posted_at: "2026-10-05T05:30:00Z",
      text: "Another step forward in electrifying mid-mile logistics. Resonia has flagged off 25 EVIATOR e-SCVs",
    },
    {
      post_url: "https://www.linkedin.com/posts/montraelectric_gandhijayanti-activity-7511639032452349952-6QDd",
      brand_id: "montraelectric",
      linkedin_id: "7511639032452349952",
      posted_at: "2026-10-02T04:11:44Z",
      text: "Gandhi Ji showed us that meaningful change begins with conscious choices. This #GandhiJayanti...",
    },
    {
      post_url: "https://www.linkedin.com/posts/montraelectrictruck_gandhijayanti-activity-7511639516160573440-7Y5g",
      brand_id: "montraelectrictruck",
      linkedin_id: "7511639516160573440",
      posted_at: "2026-10-02T04:13:00Z",
      text: "Gandhi Ji showed us that meaningful change begins with conscious choices. This #GandhiJayanti...",
    },
  ];
  const p = parseExport(book(content, "xlsx"), "c.xlsx");
  assert.equal(matchPost(p.posts[0], stored)?.brand_id, "montra-electric-scv"); // by activity id
  // ugcPost link, same text on two pages the same day: ambiguous, so no match rather than a wrong one.
  assert.equal(matchPost(p.posts[1], stored), null);
  assert.equal(matchPost(p.posts[1], stored.slice(0, 2))?.brand_id, "montraelectric"); // by text and date
  assert.equal(matchPost(p.posts[2], stored), null);
  const pages = [
    { id: "montraelectric", name: "Resonia" },
    { id: "montra-electric-scv", name: "Resonia SCV" },
    { id: "montraelectrictruck", name: "Resonia Truck" },
  ];
  assert.equal(pageFromFileName("montra-electric-scv_content_1728000000000.xls", pages), "montra-electric-scv");
  assert.equal(pageFromFileName("montraelectric_followers_1728.xls", pages), "montraelectric");
  assert.equal(pageFromFileName("Resonia Truck visitors.xlsx", pages), "montraelectrictruck");
  assert.equal(pageFromFileName("export.xls", pages), null);
});
