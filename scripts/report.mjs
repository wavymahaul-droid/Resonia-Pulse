#!/usr/bin/env node
// Prints a JSON report of the saved posts to the log (top posts per page, hashtags and their posts),
// for analysis outside the dashboard. Read-only. Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, SINCE.
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const SINCE = process.env.SINCE || "2026-05-24";
if (!SB_URL || !SB_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set");
  process.exit(1);
}
async function sb(path) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Range: `${from}-${from + 999}` },
    });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const rows = await r.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
const brands = await sb("brands?select=id,name,segment");
const posts = await sb(`posts?select=post_url,brand_id,posted_at,media_type,theme,text&posted_at=gte.${SINCE}`);
const snaps = await sb("post_snapshots?select=post_url,date,likes,comments,reposts&order=date.desc");
const latest = new Map();
for (const s of snaps) if (!latest.has(s.post_url)) latest.set(s.post_url, s);
const byId = Object.fromEntries(brands.map((b) => [b.id, b]));
const rows = posts.map((p) => {
  const s = latest.get(p.post_url) ?? {};
  const b = byId[p.brand_id];
  return {
    brand: b.name.split(" · ")[0],
    platform: b.segment,
    date: new Date(new Date(p.posted_at).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10),
    format: p.media_type,
    theme: p.theme,
    likes: s.likes ?? 0,
    comments: s.comments ?? 0,
    reposts: s.reposts ?? 0,
    interactions: (s.likes ?? 0) + (s.comments ?? 0) + (s.reposts ?? 0),
    url: p.post_url,
    text: (p.text || "").replace(/\s+/g, " ").trim(),
    tags: [...new Set(((p.text || "").match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.toLowerCase()))],
  };
});
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const report = { top: [], hashtags: [], campaigns: {} };
const groups = {};
for (const r of rows) (groups[`${r.brand}|${r.platform}`] ??= []).push(r);
for (const [k, list] of Object.entries(groups)) {
  list.sort((a, b) => b.interactions - a.interactions);
  const med = median(list.map((x) => x.interactions));
  for (const r of list.slice(0, 8))
    report.top.push({ ...r, text: r.text.slice(0, 220), tags: undefined, page_median: med, x_median: med ? +(r.interactions / med).toFixed(1) : null });
}
const tagStats = {};
for (const r of rows)
  for (const t of r.tags) {
    const k = `${r.brand}|${t}`;
    (tagStats[k] ??= { brand: r.brand, tag: t, posts: 0, ints: [], first: r.date, last: r.date, platforms: new Set() });
    const s = tagStats[k];
    s.posts++;
    s.ints.push(r.interactions);
    s.platforms.add(r.platform);
    if (r.date < s.first) s.first = r.date;
    if (r.date > s.last) s.last = r.date;
  }
report.hashtags = Object.values(tagStats)
  .filter((s) => s.posts >= 2)
  .map((s) => ({ brand: s.brand, tag: s.tag, posts: s.posts, median: median(s.ints), first: s.first, last: s.last, platforms: [...s.platforms] }))
  .sort((a, b) => a.brand.localeCompare(b.brand) || b.posts - a.posts);
const wanted = (process.env.TAGS || "").toLowerCase().split(",").map((t) => t.trim()).filter(Boolean);
for (const t of wanted)
  report.campaigns[t] = rows
    .filter((r) => r.tags.includes(t))
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({ brand: r.brand, platform: r.platform, date: r.date, format: r.format, interactions: r.interactions, url: r.url, text: r.text.slice(0, 160) }));
console.log("REPORT_JSON_START");
console.log(JSON.stringify(report));
console.log("REPORT_JSON_END");
