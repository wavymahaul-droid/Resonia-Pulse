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
const brands = await sb("brands?select=id,name,segment,linkedin_url");
const fol = await sb("follower_snapshots?select=brand_id,date,followers&order=date.desc");
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
    slug: p.brand_id,
    ist: new Date(new Date(p.posted_at).getTime() + 5.5 * 3600e3),
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
    report.top.push({ ...r, ist: undefined, text: r.text.slice(0, 220), tags: undefined, page_median: med, x_median: med ? +(r.interactions / med).toFixed(1) : null });
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
const theme = process.env.THEME;
if (theme)
  report.theme = rows
    .filter((r) => (r.theme || "Other") === theme && (!process.env.PLATFORM || r.platform === process.env.PLATFORM))
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.date.localeCompare(b.date))
    .map((r) => ({ brand: r.brand, platform: r.platform, date: r.date, format: r.format, interactions: r.interactions, url: r.url, text: r.text.slice(0, 200) }));
if (process.env.SEARCH) {
  const re = new RegExp(process.env.SEARCH, "i");
  report.search = rows
    .filter((r) => re.test(r.text))
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.date.localeCompare(b.date))
    .map((r) => ({ brand: r.brand, platform: r.platform, date: r.date, format: r.format, interactions: r.interactions, url: r.url, match: (r.text.match(re) || [""])[0], text: r.text.slice(0, 140) }));
}
if (process.env.PAGES) {
  const latestF = {};
  for (const f of fol) if (!(f.brand_id in latestF)) latestF[f.brand_id] = f;
  const slots = [[0, 9, "Before 9 am"], [9, 12, "9 am to 12 pm"], [12, 15, "12 to 3 pm"], [15, 18, "3 to 6 pm"], [18, 21, "6 to 9 pm"], [21, 24, "After 9 pm"]];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  report.pages = brands.map((b) => {
    const list = rows.filter((r) => r.slug === b.id);
    const bySlot = slots.map(([a, z, label]) => {
      const xs = list.filter((r) => r.ist.getUTCHours() >= a && r.ist.getUTCHours() < z).map((r) => r.interactions);
      return { label, posts: xs.length, median: median(xs) };
    });
    const byDay = days.map((d, i) => {
      const xs = list.filter((r) => r.ist.getUTCDay() === i).map((r) => r.interactions);
      return { label: d, posts: xs.length, median: median(xs) };
    });
    const activeDays = new Set(list.map((r) => r.date)).size;
    const dates = list.map((r) => r.date).sort();
    const avg = (k) => (list.length ? +(list.reduce((t, r) => t + r[k], 0) / list.length).toFixed(1) : null);
    const fm = {}; for (const r of list) fm[r.format] = (fm[r.format] || 0) + 1;
    return { avgLikes: avg('likes'), avgComments: avg('comments'), avgReposts: avg('reposts'), avgInt: avg('interactions'), formats: fm, id: b.id, name: b.name, platform: b.segment, url: b.linkedin_url, followers: latestF[b.id]?.followers ?? null, followers_date: latestF[b.id]?.date ?? null, posts: list.length, first: dates[0] ?? null, last: dates.at(-1) ?? null, activeDays, median: median(list.map((r) => r.interactions)), bySlot, byDay };
  });
}
if (process.env.TOPICAL) {
  const re = new RegExp(process.env.TOPICAL, "i");
  report.topical = rows
    .filter((r) => re.test(r.text))
    .sort((a, b) => a.brand.localeCompare(b.brand) || a.date.localeCompare(b.date))
    .map((r) => ({ brand: r.brand, platform: r.platform, date: r.date, format: r.format, interactions: r.interactions, url: r.url, match: [...new Set((r.text.match(new RegExp(process.env.TOPICAL, "gi")) || []).map((m) => m.toLowerCase()))].join(", "), text: r.text.slice(0, 120) }));
}
console.log("REPORT_JSON_START");
console.log(JSON.stringify(report));
console.log("REPORT_JSON_END");
