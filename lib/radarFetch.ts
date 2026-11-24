// Fetches the Industry Radar feeds (radar.json) and stores new headlines. Runs with the 7am IST
// morning cron and from "Fetch now" on /radar (signed in). Free RSS only: no Apify, no AI. Server only.
import type { SupabaseClient } from "@supabase/supabase-js";
import { clip } from "@/lib/sanitise";
import { safeWrite } from "@/lib/safeWrite";
import {
  mentionsFilter,
  parseRss,
  radarFeeds,
  RADAR,
  similarTitles,
  tagItem,
  titleKey,
  type Feed,
  type RssItem,
} from "@/lib/radar";

// Time limits, so the 7am route stays well inside Vercel's function limit: each feed gets
// FEED_TIMEOUT_MS; all feeds are fetched at once and fetching stops at FETCH_CAP_MS (feeds still
// waiting are cancelled and logged as skipped), leaving time to save before TOTAL_CAP_MS.
export const FEED_TIMEOUT_MS = 5_000;
export const FETCH_CAP_MS = 14_000;
export const TOTAL_CAP_MS = 20_000;
const UA = "Mozilla/5.0 (compatible; ResoniaPulse/1.0; +https://montra-pulse.vercel.app)";

export type FeedStatus = { name: string; url: string; ok: boolean; items: number; error: string | null };
export type RadarSummary = {
  feeds: number;
  feedsOk: number;
  fetched: number;
  saved: number;
  skipped: number; // headlines the database refused (logged in sync_rejects)
  removed: number;
  statuses: FeedStatus[];
};

async function fetchFeed(
  feed: Feed,
  cap: AbortSignal,
): Promise<{ items: (RssItem & { query: string })[]; status: FeedStatus }> {
  const own = AbortSignal.timeout(FEED_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5" },
      signal: AbortSignal.any([own, cap]),
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`Failed: HTTP ${res.status}`);
    const xml = await res.text();
    let items = parseRss(xml, feed.name.replace(/^Google News: .*/, "Google News"));
    if (!items.length) throw new Error("Failed: no items (not an RSS feed?)");
    if (feed.filter) items = items.filter((i) => mentionsFilter(`${i.title} ${i.snippet ?? ""}`));
    return {
      items: items.map((i) => ({ ...i, query: feed.query })),
      status: { name: feed.name, url: feed.url, ok: true, items: items.length, error: null },
    };
  } catch (err) {
    const error = cap.aborted
      ? `Skipped: time cap (fetching stops at ${FETCH_CAP_MS / 1000} s of the ${TOTAL_CAP_MS / 1000} s cap)`
      : own.aborted
        ? `Timed out after ${FEED_TIMEOUT_MS / 1000} s`
        : String(err instanceof Error ? err.message : err)
            .replace(/^Error: /, "")
            .slice(0, 200);
    return { items: [], status: { name: feed.name, url: feed.url, ok: false, items: 0, error } };
  }
}

export async function runRadar(db: SupabaseClient, now = new Date()): Promise<RadarSummary> {
  const feeds = radarFeeds();
  // All feeds at once; whatever has not answered by the fetch cap is cancelled.
  const cap = AbortSignal.timeout(FETCH_CAP_MS);
  const results = await Promise.all(feeds.map((f) => fetchFeed(f, cap)));

  // Feed statuses first, so the Feeds panel shows timeouts even if saving is cut short.
  const statuses = results.map((r) => r.status);
  await safeWrite(db, {
    table: "radar_feeds",
    rows: statuses.map((s) => ({
      name: s.name,
      url: s.url,
      ok: s.ok,
      items: s.items,
      error: s.error,
      checked_at: now.toISOString(),
    })),
    key: (r) => r.name,
    mode: "upsert",
    onConflict: "name",
    step: "radar",
  });
  // Feeds removed from radar.json drop out of the status list.
  await db
    .from("radar_feeds")
    .delete()
    .not("name", "in", `(${statuses.map((s) => `"${s.name.replace(/"/g, '\\"')}"`).join(",")})`);

  const cutoff = new Date(now.getTime() - RADAR.keepDays * 86_400_000).toISOString();
  // Recent items only, and no passenger car, two-wheeler or luxury EV stories.
  const fresh = results
    .flatMap((r) => r.items)
    .filter((i) => (!i.publishedAt || i.publishedAt >= cutoff) && !tagItem(i).excluded);

  // Dedupe against what is stored (same link, or a near-identical title) and within this batch.
  const { data: have, error } = await db.from("radar_items").select("url,title").gte("first_seen_at", cutoff);
  if (error) throw new Error(`radar_items select: ${error.message}`);
  const seenUrls = new Set((have ?? []).map((r) => r.url as string));
  const seenTitles = (have ?? []).map((r) => r.title as string);
  const rows: Record<string, unknown>[] = [];
  for (const i of fresh.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""))) {
    if (seenUrls.has(i.url) || seenTitles.some((t) => similarTitles(t, i.title))) continue;
    seenUrls.add(i.url);
    seenTitles.push(i.title);
    rows.push({
      url: i.url,
      title: clip(i.title, 400),
      title_key: titleKey(i.title),
      source: i.source == null ? null : clip(i.source, 120),
      snippet: i.snippet,
      published_at: i.publishedAt,
      query: clip(i.query, 120),
    });
  }
  // A headline the database refuses is skipped and logged (lib/safeWrite.ts); the others are saved.
  const saved = await safeWrite(db, {
    table: "radar_items",
    rows,
    key: (r) => String(r.url),
    mode: "upsert",
    onConflict: "url",
    ignoreDuplicates: true,
    step: "radar",
  });
  // Older than the keep window (by publication date, or first seen when the feed gave none).
  const { data: gone, error: e2 } = await db
    .from("radar_items")
    .delete()
    .or(`published_at.lt.${cutoff},and(published_at.is.null,first_seen_at.lt.${cutoff})`)
    .select("url");
  if (e2) throw new Error(`radar_items cleanup: ${e2.message}`);

  return {
    feeds: feeds.length,
    feedsOk: statuses.filter((s) => s.ok).length,
    fetched: fresh.length,
    saved: saved.saved,
    skipped: saved.rejected.length,
    removed: gone?.length ?? 0,
    statuses,
  };
}

// For the 7am route: the Radar never runs past TOTAL_CAP_MS. If saving is still going on at the cap,
// the route stops waiting (what was saved stays; the rest is picked up the next morning).
export async function runRadarCapped(db: SupabaseClient): Promise<RadarSummary | { error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<{ error: string }>((resolve) => {
    timer = setTimeout(() => resolve({ error: `Radar stopped at the ${TOTAL_CAP_MS / 1000} s cap` }), TOTAL_CAP_MS);
  });
  try {
    return await Promise.race([runRadar(db).catch((err) => ({ error: String(err).slice(0, 300) })), cap]);
  } finally {
    clearTimeout(timer);
  }
}
