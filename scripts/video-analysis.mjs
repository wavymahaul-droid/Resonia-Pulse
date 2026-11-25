#!/usr/bin/env node
// Video treatment analysis: Gemini watches each brand's video posts from the backfill window and
// describes the treatment (style, hook, voice-over, music, who appears, length, human story...).
// Runs on GitHub Actions ("4. Video analysis"). Videos are downloaded to a temp folder, sent to
// Gemini, and deleted; only Gemini's description is kept, as video-analysis.json (a run artifact).
//   Env: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY, optional APIFY_TOKEN (Instagram fallback)
//   Optional: SINCE (YYYY-MM-DD, default 2026-05-24), PER_BRAND (default 12), RESONIA_MAX (default 25)
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`${k} is not set.`);
    process.exit(1);
  }
  return v;
};
const GEMINI_KEY = env("GEMINI_API_KEY");
const SB_URL = env("SUPABASE_URL");
const SB_KEY = env("SUPABASE_SERVICE_KEY");
const APIFY = process.env.APIFY_TOKEN;
const SINCE = process.env.SINCE || "2026-05-24";
const PER_BRAND = Number(process.env.PER_BRAND || 12);
const RESONIA_MAX = Number(process.env.RESONIA_MAX || 25);
const GEMINI = "https://generativelanguage.googleapis.com";
const OUT = "video-analysis.json";

const PROMPT = `You are a social media strategist analysing a video posted by an Indian power transmission or energy infrastructure company (for example Resonia, formerly Sterlite Power; POWERGRID; IndiGrid; Adani Energy Solutions) on LinkedIn, Instagram, Facebook or X.
Watch the whole video, including audio and any on-screen text. Describe its treatment factually. Return JSON only:
- format_style: the single best fit from the list.
- duration_seconds: length of the video in seconds (your best estimate).
- aspect: "vertical", "horizontal" or "square".
- hook_first_3s: what the viewer sees and hears in the first three seconds.
- opens_with_logo: true if the video opens on a logo or brand card before any content.
- language_detected: main spoken language ("English", "Hindi", "Hinglish", other, or "none").
- voiceover: "none", "voice-over", "person on camera", or "both".
- music: "none", "background", or "dominant".
- on_screen_text: "none", "light" (a few supers), or "heavy" (the story is carried by text).
- people_shown: who appears, from the list (several allowed; empty if nobody).
- human_story: true only if the video shows how a specific person, family or community benefits or is changed (not just workers at a site).
- shows_infrastructure: true if towers, lines, substations, sites or drone shots of assets are shown.
- key_message: the one thing the video wants the viewer to take away, in one line.
- cta: the call to action, or "none".
- production_value: "high" (agency or film grade), "medium", or "low" (phone footage or simple slides).
- summary: two short lines on what is shown and said.
- treatment_notes: one or two lines on what is distinctive about the treatment (pace, editing, storytelling device, tone).`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    format_style: {
      type: "STRING",
      enum: [
        "Leader or expert talking head",
        "Site, drone and asset footage",
        "Motion graphics or animation",
        "Explainer",
        "Event coverage",
        "Festive or day greeting",
        "Employee and culture",
        "Community or beneficiary story",
        "Brand or ad film",
        "Technology or project showcase",
        "Other",
      ],
    },
    duration_seconds: { type: "NUMBER" },
    aspect: { type: "STRING", enum: ["vertical", "horizontal", "square"] },
    hook_first_3s: { type: "STRING" },
    opens_with_logo: { type: "BOOLEAN" },
    language_detected: { type: "STRING" },
    voiceover: { type: "STRING", enum: ["none", "voice-over", "person on camera", "both"] },
    music: { type: "STRING", enum: ["none", "background", "dominant"] },
    on_screen_text: { type: "STRING", enum: ["none", "light", "heavy"] },
    people_shown: {
      type: "ARRAY",
      items: {
        type: "STRING",
        enum: ["leadership", "employees or field workers", "community or beneficiaries", "customers or partners", "government officials", "celebrity or influencer"],
      },
    },
    human_story: { type: "BOOLEAN" },
    shows_infrastructure: { type: "BOOLEAN" },
    key_message: { type: "STRING" },
    cta: { type: "STRING" },
    production_value: { type: "STRING", enum: ["high", "medium", "low"] },
    summary: { type: "STRING" },
    treatment_notes: { type: "STRING" },
  },
  required: [
    "format_style", "duration_seconds", "aspect", "hook_first_3s", "opens_with_logo", "language_detected",
    "voiceover", "music", "on_screen_text", "people_shown", "human_story", "shows_infrastructure",
    "key_message", "cta", "production_value", "summary", "treatment_notes",
  ],
};

// ---------- 1. Which videos ----------
async function sb(path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const PLATFORM_ORDER = { x: 0, linkedin: 1, facebook: 2, instagram: 3 }; // easiest to download first
const norm = (s) => (s || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[^a-z0-9]+/g, " ").trim().slice(0, 60);

async function candidates() {
  const brands = await sb("brands?select=id,name,segment,is_montra");
  const byId = Object.fromEntries(brands.map((b) => [b.id, b]));
  const posts = await sb(
    `posts?select=post_url,brand_id,posted_at,text&media_type=eq.video&posted_at=gte.${SINCE}&order=posted_at.desc&limit=2000`,
  );
  const groups = new Map(); // brand name -> distinct videos
  for (const p of posts) {
    const b = byId[p.brand_id];
    if (!b) continue;
    const brand = b.name.split(" · ")[0];
    const list = groups.get(brand) ?? [];
    const key = norm(p.text);
    const twin = key && list.find((c) => c.key === key);
    const c = { ...p, brand, platform: b.segment, resonia: b.is_montra, key, also: [] };
    if (twin) {
      twin.also.push(c);
      continue; // same video cross-posted on another platform: analyse once
    }
    list.push(c);
    groups.set(brand, list);
  }
  const picked = [];
  for (const [brand, list] of groups) {
    const cap = list[0]?.resonia ? RESONIA_MAX : PER_BRAND;
    picked.push(...list.slice(0, cap));
  }
  console.log(`Video posts since ${SINCE}: ${posts.length}; distinct videos picked: ${picked.length}`);
  for (const [brand, list] of groups) console.log(`  ${brand}: ${list.length} distinct`);
  return picked;
}

// ---------- 2. Download ----------
async function ytdlp(url, file) {
  await run("yt-dlp", ["--no-playlist", "--no-cookies", "--max-filesize", "200M", "-f", "best[ext=mp4]/best", "-o", file, url], {
    timeout: 300_000,
  });
  if (!existsSync(file) || statSync(file).size < 10_000) throw new Error("no file");
}
async function apifyInstagramVideoUrl(postUrl) {
  if (!APIFY) throw new Error("no APIFY_TOKEN");
  const r = await fetch(
    `https://api.apify.com/v2/acts/apify~instagram-post-scraper/run-sync-get-dataset-items?timeout=120&maxTotalChargeUsd=0.02`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${APIFY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ username: [postUrl], resultsLimit: 1 }),
    },
  );
  const items = await r.json();
  const v = Array.isArray(items) ? items[0]?.videoUrl : null;
  if (!v) throw new Error("Apify returned no videoUrl");
  return v;
}
async function download(c, dir) {
  const tries = [c, ...c.also].sort((a, b) => PLATFORM_ORDER[a.platform] - PLATFORM_ORDER[b.platform]);
  const errors = [];
  for (const t of tries) {
    const file = join(dir, `${Math.random().toString(36).slice(2)}.mp4`);
    try {
      await ytdlp(t.post_url, file);
      return { file, from: t.platform };
    } catch (e) {
      errors.push(`${t.platform} yt-dlp: ${String(e.stderr || e.message || e).split("\n").filter((l) => /ERROR/.test(l)).join(" ").slice(0, 160) || "failed"}`);
    }
    if (t.platform === "instagram") {
      try {
        const v = await apifyInstagramVideoUrl(t.post_url);
        const buf = Buffer.from(await (await fetch(v, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
        writeFileSync(file, buf);
        if (buf.length > 10_000) return { file, from: "instagram (Apify link)" };
      } catch (e) {
        errors.push(`instagram Apify: ${String(e.message || e).slice(0, 120)}`);
      }
    }
  }
  throw new Error(errors.join("; "));
}

// ---------- 3. Gemini ----------
async function gemini(path, init = {}) {
  const res = await fetch(`${GEMINI}${path}`, {
    signal: AbortSignal.timeout(180_000),
    ...init,
    headers: { "x-goog-api-key": GEMINI_KEY, ...(init.headers || {}) },
  });
  const body = await res.text();
  if (!res.ok) throw Object.assign(new Error(`Gemini ${res.status}: ${body.slice(0, 300)}`), { status: res.status });
  return body ? JSON.parse(body) : {};
}
async function pickModel() {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  const { models = [] } = await gemini("/v1beta/models?pageSize=200");
  const version = (n) => Number(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const names = models
    .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /^gemini-\d+(?:\.\d+)?-flash(-preview.*)?$/.test(n) && !/lite|live|tts|image|audio|thinking/.test(n))
    .sort((a, b) => version(b) - version(a) || a.length - b.length);
  if (!names.length) throw new Error("No Gemini Flash model available for this key");
  return names.find((n) => !/preview/.test(n)) ?? names[0];
}
async function upload(file) {
  const bytes = readFileSync(file);
  const start = await fetch(`${GEMINI}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_KEY,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.length),
      "X-Goog-Upload-Header-Content-Type": "video/mp4",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: "resonia-pulse-video" } }),
  });
  const url = start.headers.get("x-goog-upload-url");
  if (!start.ok || !url) throw new Error(`Gemini upload start ${start.status}`);
  const done = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(240_000),
    headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize", "Content-Length": String(bytes.length) },
    body: bytes,
  });
  if (!done.ok) throw new Error(`Gemini upload ${done.status}`);
  let f = (await done.json()).file;
  for (let i = 0; f.state === "PROCESSING" && i < 60; i++) {
    await sleep(5000);
    f = await gemini(`/v1beta/${f.name}`);
  }
  if (f.state !== "ACTIVE") throw new Error(`Gemini could not process the video (${f.state})`);
  return f;
}
async function analyse(model, f) {
  const body = JSON.stringify({
    contents: [{ parts: [{ file_data: { mime_type: f.mimeType, file_uri: f.uri } }, { text: PROMPT }] }],
    generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await gemini(`/v1beta/models/${model}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json" }, body });
      const text = r.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!text) throw new Error(`no answer (${r.candidates?.[0]?.finishReason ?? "unknown"})`);
      return JSON.parse(text);
    } catch (e) {
      if (attempt < 3 && [429, 500, 503].includes(e.status)) {
        console.log(`   Gemini ${e.status}; waiting 45 s`);
        await sleep(45_000);
        continue;
      }
      throw e;
    }
  }
}

// ---------- main ----------
const list = await candidates();
const model = await pickModel();
console.log(`Gemini model: ${model}\n`);
const dir = mkdtempSync(join(tmpdir(), "rp-video-"));
const results = [];
try {
  for (const [i, c] of list.entries()) {
    process.stdout.write(`[${i + 1}/${list.length}] ${c.brand} · ${c.platform} · ${c.posted_at?.slice(0, 10)} ... `);
    let f;
    try {
      const got = await download(c, dir);
      f = await upload(got.file);
      rmSync(got.file, { force: true });
      const a = await analyse(model, f);
      results.push({ brand: c.brand, platform: c.platform, also_on: c.also.map((x) => x.platform), post_url: c.post_url, posted_at: c.posted_at, caption: (c.text || "").slice(0, 300), source: got.from, ...a });
      console.log(`${a.format_style}, ${Math.round(a.duration_seconds)}s, ${a.aspect}`);
    } catch (e) {
      results.push({ brand: c.brand, platform: c.platform, post_url: c.post_url, posted_at: c.posted_at, caption: (c.text || "").slice(0, 300), error: String(e.message || e).slice(0, 400) });
      console.log(`skipped: ${String(e.message || e).slice(0, 200)}`);
    } finally {
      if (f?.name) gemini(`/v1beta/${f.name}`, { method: "DELETE" }).catch(() => {});
    }
    writeFileSync(OUT, JSON.stringify({ model, since: SINCE, results }, null, 2));
    await sleep(4000); // stay inside the free tier's per-minute limit
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const ok = results.filter((r) => !r.error).length;
console.log(`\nAnalysed ${ok} of ${results.length} videos. Saved ${OUT}.`);
