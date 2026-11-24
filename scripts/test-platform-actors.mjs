#!/usr/bin/env node
// Run this once before the backfill: each Instagram, Facebook and X actor on one page with 3 posts,
// to check they answer and return the fields lib/platforms.ts reads. Costs a few cents in all.
//   APIFY_TOKEN=... node scripts/test-platform-actors.mjs
const TOKEN = process.env.APIFY_TOKEN;
if (!TOKEN) {
  console.error("APIFY_TOKEN is not set.");
  process.exit(1);
}
const API = "https://api.apify.com/v2";
const CAP_USD = 0.05;

const RUNS = [
  ["apify~instagram-post-scraper", { username: ["pgcilindia"], resultsLimit: 3 }, ["shortCode", "caption", "timestamp", "likesCount", "commentsCount", "type", "displayUrl", "ownerUsername"]],
  ["apify~instagram-profile-scraper", { usernames: ["pgcilindia"] }, ["username", "followersCount"]],
  ["apify~facebook-posts-scraper", { startUrls: [{ url: "https://www.facebook.com/pgcilindia" }], resultsLimit: 3 }, ["postId", "url", "text", "time", "likes", "comments", "shares", "media"]],
  ["apify~facebook-pages-scraper", { startUrls: [{ url: "https://www.facebook.com/pgcilindia" }] }, ["followers", "likes"]],
  ["scrape.badger~twitter-tweets-scraper", { mode: "Advanced Search", query: "from:pgcilindia -filter:replies -filter:retweets", query_type: "Latest", max_results: 3 }, ["id", "full_text", "created_at", "username", "favorite_count", "reply_count", "retweet_count", "user_followers_count", "media"]],
];

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...init.headers },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

for (const [actor, input, fields] of RUNS) {
  process.stdout.write(`\n== ${actor}\n`);
  try {
    let r = (await api(`/acts/${actor}/runs?timeout=180&waitForFinish=60&maxTotalChargeUsd=${CAP_USD}&maxItems=5`, { method: "POST", body: JSON.stringify(input) })).data;
    while (r.status === "READY" || r.status === "RUNNING") r = (await api(`/actor-runs/${r.id}?waitForFinish=60`)).data;
    const items = await api(`/datasets/${r.defaultDatasetId}/items?clean=true`);
    await new Promise((s) => setTimeout(s, 4000));
    r = (await api(`/actor-runs/${r.id}`)).data;
    console.log(`  ${r.status}, ${items.length} items, $${(r.usageTotalUsd ?? 0).toFixed(4)}`);
    const first = items[0] ?? {};
    for (const f of fields) console.log(`  ${f in first ? "ok     " : "MISSING"} ${f}: ${JSON.stringify(first[f])?.slice(0, 90)}`);
  } catch (err) {
    console.log(`  FAILED: ${String(err).slice(0, 300)}`);
  }
}
