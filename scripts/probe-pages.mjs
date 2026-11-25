#!/usr/bin/env node
// Check whether candidate Instagram usernames and Facebook pages exist, with follower counts and last post.
//   APIFY_TOKEN=... IG="a,b" FB="https://facebook.com/x,https://facebook.com/y" node scripts/probe-pages.mjs
const TOKEN = process.env.APIFY_TOKEN, API = "https://api.apify.com/v2";
const IG = (process.env.IG ?? "").split(",").filter(Boolean);
const FB = (process.env.FB ?? "").split(",").filter(Boolean);
async function run(actor, input) {
  const res = await fetch(`${API}/acts/${actor}/run-sync-get-dataset-items?timeout=240&maxTotalChargeUsd=0.1`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
  const t = await res.text(); if (!res.ok) throw new Error(`${res.status} ${t.slice(0, 300)}`); return JSON.parse(t);
}
if (IG.length) {
  const items = await run("apify~instagram-profile-scraper", { usernames: IG });
  for (const u of IG) {
    const p = items.find((i) => (i.username ?? "").toLowerCase() === u.toLowerCase());
    console.log(`IG ${u}: ${p ? `${p.fullName} | ${p.followersCount} followers | ${p.postsCount} posts | verified ${p.verified} | latest ${p.latestPosts?.[0]?.timestamp ?? "-"} | bio ${(p.biography ?? "").slice(0, 80)}` : "NOT FOUND"}`);
  }
}
for (const url of FB) {
  try {
    const items = await run("apify~facebook-pages-scraper", { startUrls: [{ url }] });
    const p = items[0];
    console.log(`FB ${url}: ${p && !p.error ? `${p.title} | ${p.followers} followers | ${p.categories ?? ""} | ${p.pageUrl ?? ""}` : "NOT FOUND " + JSON.stringify(p ?? {}).slice(0, 120)}`);
  } catch (e) { console.log(`FB ${url}: FAILED ${String(e).slice(0, 150)}`); }
}
