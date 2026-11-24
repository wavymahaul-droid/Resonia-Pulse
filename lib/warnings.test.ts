import assert from "node:assert/strict";
import { test } from "node:test";
import { tagSentiment } from "./sentiment";
import { explainFailure, syncWarnings, type RunRow } from "./warnings";

const brands = [
  { id: "a", name: "Page A" },
  { id: "b", name: "Page B" },
];
const run = (started_at: string, extra: Partial<RunRow> = {}): RunRow => ({
  started_at,
  status: "success",
  notes: null,
  pages_failed: [],
  pages_attempted: ["a", "b"],
  ...extra,
});
const now = new Date("2026-10-08T12:30:00Z");

test("warnings: failed run explained in plain English", () => {
  // The 5 Oct cron run.
  const notes =
    'Error: Apify 401 /users/me/limits: { "error": { "type": "token-not-provided", "message": "Authentication token was not provided" } }';
  assert.deepEqual(
    syncWarnings([run("2026-10-08T11:54:00Z", { status: "failed", notes, pages_attempted: [] })], brands, now),
    ["Apify rejected the token: re-paste APIFY_TOKEN in Vercel and redeploy."],
  );
  assert.match(explainFailure("Error: APIFY_TOKEN is set but empty (only spaces or quotes)"), /re-paste APIFY_TOKEN/);
  assert.match(explainFailure('Apify 401 {"type":"user-or-token-not-found"}'), /did not recognise the token/);
  assert.match(explainFailure('relation "x_tweets" does not exist'), /schema\.sql/);
  assert.match(explainFailure("TypeError: fetch failed"), /usually fixes itself/);
  assert.match(explainFailure("Something odd"), /^The last sync failed: Something odd\.$/);
});

test("warnings: skipped for budget, and comments or X skipped for budget", () => {
  const skipped = run("2026-10-08T11:30:00Z", {
    status: "skipped",
    notes: "Skipped: Apify usage this month is $4.97, above the $4.95 limit",
    pages_attempted: [],
  });
  assert.match(
    syncWarnings([skipped], brands, now)[0],
    /skipped for budget: Apify usage this month \(\$4\.97\) is above the \$4\.95 limit/,
  );
  const partial = run("2026-10-08T11:30:00Z", {
    notes: "Comments skipped: Apify usage $4.90 + ... X skipped: Apify usage $4.90 ...",
  });
  assert.match(syncWarnings([partial], brands, now)[0], /comments and X were skipped/);
  assert.deepEqual(syncWarnings([run("2026-10-08T11:30:00Z")], brands, now), []);
});

test("warnings: a page with no posts 3 days in a row, and a cron that stopped", () => {
  const failB = { pages_failed: ["b"] };
  const runs = [
    run("2026-10-08T11:30:00Z", failB),
    run("2026-10-07T13:00:00Z"), // a later hand run on 7 Oct that worked counts for that day
    run("2026-10-07T11:30:00Z", failB),
    run("2026-10-06T11:30:00Z", failB),
    run("2026-10-05T11:30:00Z", failB),
  ];
  assert.deepEqual(syncWarnings(runs, brands, now), []);
  const three = [
    run("2026-10-08T11:30:00Z", failB),
    run("2026-10-07T11:30:00Z", failB),
    run("2026-10-06T11:30:00Z", failB),
  ];
  assert.match(syncWarnings(three, brands, now)[0], /no posts for Page B 3 days in a row/);
  // Skipped days are not counted as "no posts".
  const withSkip = [three[0], run("2026-10-07T11:30:00Z", { status: "skipped", pages_attempted: [] }), three[2]];
  assert.deepEqual(syncWarnings(withSkip, brands, now), []);
  assert.match(syncWarnings([run("2026-10-06T11:30:00Z")], brands, now)[0], /No sync has run for 2 day\(s\)/);
});

test("farmer and tractor phrases", () => {
  assert.equal(tagSentiment("Main kisan hoon, tractor kitne ka hai?"), "Lead");
  assert.equal(tagSentiment("Subsidy milegi kya?"), "Lead");
  assert.equal(tagSentiment("Loan ya EMI option hai?"), "Lead");
  assert.equal(tagSentiment("Dealer near me in Nashik"), "Lead");
  assert.equal(tagSentiment("Price kitna hai"), "Lead");
  assert.equal(tagSentiment("Charging problem aa rahi hai"), "Negative");
  assert.equal(tagSentiment("Tractor khet mein band ho gaya"), "Negative");
  assert.equal(tagSentiment("Battery problem in my tractor"), "Negative");
  assert.equal(tagSentiment("Mileage kitna hai?"), "Question"); // "kitna" alone is a question, not a price ask
  assert.equal(tagSentiment("Battery kitne ghante chalegi?"), "Question");
  assert.equal(tagSentiment("Range kitna hai"), "Question");
});
