import assert from "node:assert/strict";
import { test } from "node:test";
import type { ParsedExport } from "./liexport";
import { saveExport } from "./liupload";

// A stand-in for the Supabase client: records writes, serves the tracked posts. `origin` = whether
// schema.sql has added posts.origin.
function fakeDb(posts: object[], { origin = true } = {}) {
  const writes: { table: string; op: string; rows: unknown; opts?: unknown }[] = [];
  return {
    writes,
    from: (table: string) => {
      let cols = "";
      const query = {
        select: (c: string) => ((cols = c), query),
        in: () => query,
        gte: () => query,
        lte: () => query,
        eq: () => query,
        not: () => query,
        // Awaited directly (the report history fill reads daily rows): nothing stored yet.
        then: (done: (r: { data: unknown[]; error: null }) => void) => done({ data: [], error: null }),
        limit: async () =>
          !origin && cols.includes("origin")
            ? { data: null, error: { message: "column posts.origin does not exist" } }
            : { data: posts, error: null },
      };
      return {
        ...query,
        upsert: async (rows: unknown, opts: unknown) => (
          writes.push({ table, op: "upsert", rows, opts }),
          { error: null }
        ),
        insert: async (rows: unknown) => (writes.push({ table, op: "insert", rows }), { error: null }),
        update: (rows: unknown) => ({
          in: () => ({ eq: async () => (writes.push({ table, op: "update", rows }), { error: null }) }),
        }),
      };
    },
  };
}
const rowsOf = (db: ReturnType<typeof fakeDb>, table: string) =>
  db.writes.filter((w) => w.table === table).flatMap((w) => w.rows as Record<string, unknown>[]);

const parsed: ParsedExport = {
  kinds: ["content", "followers"],
  posts: [
    {
      link: "https://www.linkedin.com/feed/update/urn:li:activity:7512745907554205697",
      ids: ["7512745907554205697"],
      title: "Another step forward",
      created: "2026-10-05",
      impressions: 5432,
      clicks: 87,
      ctr: 0.016,
      reactions: 119,
      comments: 2,
      reposts: 2,
      engagementRate: 0.0382,
      contentType: "Image",
      postType: "Organic",
      sponsored: false,
      raw: { Impressions: 5432 },
    },
    {
      link: "https://www.linkedin.com/feed/update/urn:li:share:7400000000000000000",
      ids: ["7400000000000000000"],
      title: "An old post the tracker never saw",
      created: "2026-08-01",
      impressions: 300,
      clicks: 3,
      ctr: 0.01,
      reactions: 10,
      comments: 0,
      reposts: 0,
      engagementRate: null,
      contentType: "Text",
      postType: "Organic",
      sponsored: false,
      raw: { Impressions: 300 },
    },
  ],
  daily: [
    { date: "2026-10-01", impressions: 1500, clicks: 50 },
    { date: "2026-10-02", new_followers: 12, new_followers_organic: 9 },
  ],
  dateFrom: "2026-08-01",
  dateTo: "2026-10-05",
  warnings: [],
};
const stored = [
  {
    post_url: "https://www.linkedin.com/posts/montra-electric-scv_x-activity-7512745907554205697-pqSM",
    brand_id: "montra-electric-scv",
    linkedin_id: "7512745907554205697",
    posted_at: "2026-10-05T05:30:00Z",
    text: "Another step forward in electrifying mid-mile logistics.",
  },
];

test("saving an export: matched posts, a new post for the unmatched row, daily rows, upload log", async () => {
  const db = fakeDb(stored);
  const r = await saveExport(db as never, parsed, { page: "montraelectric", file: "montraelectric_content.xls" });
  assert.deepEqual([r.matched, r.created, r.unmatched.length, r.otherPage], [1, 1, 0, 1]); // matched post is on the SCV page
  assert.deepEqual(
    rowsOf(db, "li_post_metrics").map((p) => [p.post_url, p.brand_id, p.impressions, p.ctr]),
    [
      [stored[0].post_url, "montra-electric-scv", 5432, 0.016],
      [parsed.posts[1].link, "montraelectric", 300, 0.01], // the new post's own record
    ],
  );
  // The post the tracker never saw becomes a post from the export, with a snapshot of its numbers.
  assert.deepEqual(rowsOf(db, "posts"), [
    {
      post_url: parsed.posts[1].link,
      brand_id: "montraelectric",
      linkedin_id: "7400000000000000000",
      posted_at: "2026-08-01T12:00:00+05:30",
      text: "An old post the tracker never saw",
      media_type: "text",
      theme: rowsOf(db, "posts")[0].theme,
      origin: "export",
    },
  ]);
  assert.deepEqual(
    rowsOf(db, "post_snapshots").map((x) => [x.post_url, x.likes, x.comments, x.reposts]),
    [[parsed.posts[1].link, 10, 0, 0]],
  );
  // Rows with different columns go in separate upserts, so one file never blanks another's columns.
  const daily = db.writes.filter((w) => w.table === "li_page_metrics");
  assert.equal(daily.length, 2);
  assert.deepEqual(Object.keys((daily[0].rows as object[])[0]).sort(), [
    "brand_id",
    "clicks",
    "date",
    "impressions",
    "updated_at",
  ]);
  const log = rowsOf(db, "li_uploads")[0];
  assert.deepEqual(
    [log.kinds, log.posts_matched, log.posts_unmatched, log.date_to],
    ["content,followers", 1, 0, "2026-10-05"],
  );
});

test("a post created from an earlier export is matched by its link and its numbers updated", async () => {
  const earlier = {
    post_url: parsed.posts[1].link,
    brand_id: "montraelectric",
    linkedin_id: "7400000000000000000",
    posted_at: "2026-08-01T06:30:00Z",
    text: "An old post the tracker never saw",
    origin: "export",
  };
  const db = fakeDb([...stored, earlier]);
  const r = await saveExport(db as never, parsed, { page: "montraelectric", file: "c.xls" });
  assert.deepEqual([r.matched, r.created], [2, 0]);
  assert.equal(rowsOf(db, "posts").length, 0);
  assert.deepEqual(
    rowsOf(db, "post_snapshots").map((x) => x.post_url),
    [earlier.post_url],
  );
});

test("an export row on no feed and marked sponsored, or without a feed link, is an ad (not on feed)", async () => {
  const dark = { ...parsed.posts[1], postType: "Sponsored", sponsored: true };
  const noFeed = {
    ...parsed.posts[1],
    link: "https://www.linkedin.com/campaignmanager/accounts/1/campaigns/2",
    ids: [],
    title: "A campaign-only post with no feed link",
  };
  const boosted = { ...parsed.posts[0], postType: "Sponsored", sponsored: true }; // on the feed: organic
  const db = fakeDb(stored);
  const r = await saveExport(
    db as never,
    { ...parsed, posts: [boosted, dark, noFeed] },
    { page: "montraelectric", file: "c.xls" },
  );
  assert.deepEqual([r.matched, r.created, r.ads], [1, 2, 2]);
  assert.deepEqual(
    rowsOf(db, "posts").map((p) => p.origin),
    ["ad", "ad"],
  );
  // A post created from an earlier export that this export marks sponsored is re-labelled.
  const earlier = {
    ...stored[0],
    post_url: dark.link,
    linkedin_id: "7400000000000000000",
    text: dark.title,
    origin: "export",
  };
  const db2 = fakeDb([earlier]);
  const r2 = await saveExport(db2 as never, { ...parsed, posts: [dark] }, { page: "montraelectric", file: "c.xls" });
  assert.equal(r2.ads, 1);
  assert.deepEqual(
    db2.writes.filter((w) => w.op === "update").map((w) => w.rows),
    [{ origin: "ad" }],
  );
});

test("before schema.sql adds posts.origin, unmatched rows are kept for later with a warning", async () => {
  const db = fakeDb(stored, { origin: false });
  const r = await saveExport(db as never, parsed, { page: "montraelectric", file: "c.xls" });
  assert.deepEqual([r.created, r.unmatched.length], [0, 1]);
  assert.equal(rowsOf(db, "posts").length, 0);
  assert.match(r.warnings.join(" "), /Re-run supabase\/schema\.sql to add posts/);
});

test("without a page, daily numbers and unmatched posts are not saved, with a warning", async () => {
  const db = fakeDb(stored);
  const r = await saveExport(db as never, parsed, { page: null, file: "export.xls" });
  assert.equal(db.writes.filter((w) => w.table === "li_page_metrics").length, 0);
  assert.equal(rowsOf(db, "li_post_metrics").length, 1);
  assert.equal(rowsOf(db, "posts").length, 0);
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings.join(" "), /pick which Resonia page/);
});
