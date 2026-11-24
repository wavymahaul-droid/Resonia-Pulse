// Daily X step for @MontraElectric, run after the LinkedIn posts and comments.
// Source: scrape.badger/twitter-tweets-scraper (no login), $0.00015 per tweet, no start fee
// or minimum charge. Four small runs:
//   1. search: tweets tagging @MontraElectric, replying to it, or naming "Resonia"
//   2. our latest 5 posts (not replies), for their engagement and the follower count
//   3. our replies, which are stored (never flagged) and mark the tweet they answer handled
//   4. by id, tweets we replied to that the search did not return (X search hides some)
import type { SupabaseClient } from "@supabase/supabase-js";
import { billingCycle, runActor } from "@/lib/apify";
import { postReserveUsd } from "@/lib/comments";
import { lastStepSuccess, windowStart } from "@/lib/runs";
import { needsResponse, tagSentiment } from "@/lib/sentiment";
import { safeWrite, type WriteResult } from "@/lib/safeWrite";
import { X_HANDLE, answeredBy, isOwn, missingParents, sentimentText, xRow, type BadgerTweet, type XRow } from "@/lib/x";

const ACTOR = "scrape.badger~twitter-tweets-scraper";
export const PRICE_PER_TWEET_USD = 0.00015;
const MAX_MENTIONS = 30;
const MAX_REPLIES = 20;
const LATEST_POSTS = 5;
const MAX_LOOKUP = 20;
// Comments get a share of the budget before X: they cost about $0.03-0.06 a month.
const COMMENT_RESERVE_PER_DAY_USD = 0.002;
// Below this much headroom the X step is skipped; a typical day costs about $0.0015.
const MIN_HEADROOM_USD = 0.002;
const FIRST_RUN_DAYS = 7;

export type XSyncSummary = {
  status: "success" | "skipped" | "failed";
  costUsd: number;
  since: string | null; // start of the search window (ISO)
  fetched: number; // tweets returned by the four runs
  saved: { mentions: number; posts: number; replies: number; recovered: number }; // new rows
  alreadySaved: number; // mentions and replies skipped because they were saved before
  flagged: number; // new mentions that need a response
  media: number; // new media mentions
  autoHandled: number;
  followers: number | null;
  runIds: string[];
  notes: string;
  rows: XRow[]; // everything fetched (also on a dry run)
  writes?: WriteResult[]; // rows saved and skipped per table
};

const empty = (notes: string, status: XSyncSummary["status"] = "skipped"): XSyncSummary => ({
  status,
  costUsd: 0,
  since: null,
  fetched: 0,
  saved: { mentions: 0, posts: 0, replies: 0, recovered: 0 },
  alreadySaved: 0,
  flagged: 0,
  media: 0,
  autoHandled: 0,
  followers: null,
  runIds: [],
  notes,
  rows: [],
});

export async function xTablesReady(db: SupabaseClient): Promise<boolean> {
  const [a, b] = await Promise.all([
    db.from("x_tweets").select("tweet_id").limit(1),
    db.from("x_follower_snapshots").select("date").limit(1),
  ]);
  return !a.error && !b.error;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
// IST calendar date, as for the LinkedIn follower snapshots.
const istDate = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

// First UTC day to search. Daily: from yesterday. After missed days: from the day before the
// last successful X sync (its follower snapshot), at most 7 days back. First run: 7 days.
export function searchSince(lastSnapshot: string | null, now = new Date()): string {
  const floor = now.getTime() - FIRST_RUN_DAYS * 86_400_000;
  const yesterday = now.getTime() - 86_400_000;
  if (!lastSnapshot) return utcDay(floor);
  const last = Date.parse(`${lastSnapshot}T00:00:00Z`) - 86_400_000;
  return utcDay(Math.max(floor, Math.min(yesterday, last)));
}

type Run = { items: BadgerTweet[]; usageUsd: number; runId: string; status: string };

async function search(query: string, max: number, capUsd: number): Promise<Run> {
  return runActor<BadgerTweet>(
    ACTOR,
    { mode: "Advanced Search", query, query_type: "Latest", max_results: max },
    capUsd,
  );
}

const capFor = (n: number) => n * PRICE_PER_TWEET_USD * 1.2 + 0.0005;

export async function syncX(
  db: SupabaseClient | null,
  {
    budgetUsd,
    dryRun = false,
    days,
    ignoreReserve = false,
    includePosts = true,
    includeTodaysPosts = false,
    syncRunId = null,
  }: {
    budgetUsd: number;
    dryRun?: boolean;
    days?: number;
    ignoreReserve?: boolean;
    includePosts?: boolean; // our latest posts and the follower count: evening run only
    includeTodaysPosts?: boolean; // morning/afternoon scans: today's evening post sync is still to come
    syncRunId?: number | null; // sync_runs.id, for the skipped-items log
  },
): Promise<XSyncSummary> {
  const ready = db ? await xTablesReady(db) : false;
  if (!ready && !dryRun) return empty("X skipped: re-run supabase/schema.sql to add the x_tweets table");

  // Budget: the rest of this cycle's post syncs and comment steps are set aside first.
  const cycle = await billingCycle();
  const daysLeft = Math.max(0, Math.floor((Date.parse(cycle.endsAt) - Date.now()) / 86_400_000));
  const reserve = ignoreReserve
    ? 0
    : postReserveUsd(cycle.endsAt, new Date(), { includeToday: includeTodaysPosts }) +
      daysLeft * COMMENT_RESERVE_PER_DAY_USD;
  const headroom = budgetUsd - cycle.usageUsd - reserve;
  if (headroom < MIN_HEADROOM_USD) {
    return empty(
      `X skipped: Apify usage $${cycle.usageUsd.toFixed(2)} + $${reserve.toFixed(2)} set aside for this cycle's post and comment syncs leaves too little of the $${budgetUsd.toFixed(2)} budget`,
    );
  }

  let lastSnapshot: string | null = null;
  if (db && ready) {
    const { data } = await db
      .from("x_follower_snapshots")
      .select("date")
      .eq("handle", X_HANDLE)
      .order("date", { ascending: false })
      .limit(1);
    lastSnapshot = data?.[0]?.date ?? null;
  }
  // From the last successful X run minus a 1-hour overlap (at most 7 days back). Before any run
  // has recorded x_status, fall back to the day before the last follower snapshot.
  const startedAt = new Date();
  const last = db && ready && !days ? await lastStepSuccess(db, "x") : null;
  const sinceDate = days
    ? new Date(startedAt.getTime() - days * 86_400_000)
    : last
      ? windowStart(last, startedAt, FIRST_RUN_DAYS * 86_400_000, FIRST_RUN_DAYS * 86_400_000)
      : new Date(`${searchSince(lastSnapshot, startedAt)}T00:00:00Z`);
  const since = sinceDate.toISOString();
  const sinceTime = Math.floor(sinceDate.getTime() / 1000);

  // Spending caps, in priority order: mentions, our replies, our posts; the lookup gets the rest.
  let left = headroom;
  const take = (n: number) => {
    const cap = Math.max(0.0005, Math.min(capFor(n), left));
    left -= cap;
    return cap;
  };
  const capMentions = take(MAX_MENTIONS);
  const capReplies = take(MAX_REPLIES);
  const capPosts = includePosts ? take(LATEST_POSTS) : 0;
  const none: Run = { items: [], usageUsd: 0, runId: "", status: "SUCCEEDED" };
  const [mentions, replies, posts] = await Promise.all([
    search(
      `(@${X_HANDLE} OR to:${X_HANDLE} OR "Resonia") -from:${X_HANDLE} since_time:${sinceTime}`,
      MAX_MENTIONS,
      capMentions,
    ),
    search(`from:${X_HANDLE} filter:replies since_time:${sinceTime}`, MAX_REPLIES, capReplies),
    includePosts ? search(`from:${X_HANDLE} -filter:replies`, LATEST_POSTS, capPosts) : Promise.resolve(none),
  ]);
  const runs: Run[] = [mentions, replies, ...(includePosts ? [posts] : [])];
  const notes: string[] = [];

  // Tweets we replied to that are neither in this fetch nor saved before.
  const fetchedIds = new Set([...mentions.items, ...replies.items, ...posts.items].map((t) => String(t.id)));
  let parents = missingParents(replies.items, fetchedIds);
  if (db && ready && parents.length) {
    const { data, error } = await db.from("x_tweets").select("tweet_id").in("tweet_id", parents);
    if (error) throw new Error(`x_tweets select: ${error.message}`);
    const saved = new Set(data.map((r) => r.tweet_id as string));
    parents = parents.filter((id) => !saved.has(id));
  }
  let lookup: BadgerTweet[] = [];
  if (parents.length) {
    const ids = parents.slice(0, MAX_LOOKUP);
    const run = await runActor<BadgerTweet>(
      ACTOR,
      { mode: "Get a Few Tweets", tweets: ids.join(",") },
      Math.max(0.0005, Math.min(capFor(ids.length), left + 0.0005)),
    );
    runs.push(run);
    lookup = run.items;
    if (parents.length > ids.length)
      notes.push(`${parents.length - ids.length} replied-to tweets left for a later run`);
  }
  for (const r of runs)
    if (r.status !== "SUCCEEDED") notes.push(`Apify run ${r.runId} ended ${r.status} (spending cap)`);

  const costUsd = runs.reduce((s, r) => s + Math.max(r.usageUsd, r.items.length * PRICE_PER_TWEET_USD), 0);
  const now = new Date().toISOString();
  const byId = new Map<string, XRow>();
  const add = (items: BadgerTweet[], source: "search" | "own" | "reply_lookup") => {
    for (const t of items) {
      if (!t?.id || t.is_retweet || byId.has(String(t.id))) continue;
      byId.set(String(t.id), xRow(t, isOwn(t) ? "own" : source, now));
    }
  };
  add(posts.items, "own");
  add(replies.items, "own");
  add(mentions.items, "search");
  add(lookup, "reply_lookup");
  const rows = [...byId.values()];
  const ownPosts = rows.filter((r) => r.kind === "post");
  // X sometimes returns 0 followers on one of our tweets; take the highest count we were given.
  const followers =
    Math.max(0, ...rows.filter((r) => r.kind !== "mention").map((r) => r.author_followers ?? 0)) || null;

  const summary: XSyncSummary = {
    ...empty(""),
    status: "success",
    costUsd,
    since,
    fetched: runs.reduce((s, r) => s + r.items.length, 0),
    followers,
    runIds: runs.map((r) => r.runId),
    rows,
  };
  if (!db || dryRun || !ready) {
    const fresh = rows.filter((r) => r.kind === "mention");
    summary.flagged = fresh.filter((r) => r.needs_response).length;
    summary.media = fresh.filter((r) => r.is_media).length;
    summary.notes = [...notes, dryRun ? "Dry run: nothing saved" : ""].filter(Boolean).join(". ");
    return summary;
  }

  // Mentions and replies already saved are skipped, so their sentiment and "handled" stay as they are.
  const others = rows.filter((r) => r.kind !== "post");
  const { data: existing, error: e0 } = await db
    .from("x_tweets")
    .select("tweet_id")
    .in(
      "tweet_id",
      others.map((r) => r.tweet_id),
    );
  if (e0) throw new Error(`x_tweets select: ${e0.message}`);
  const savedIds = new Set(existing.map((r) => r.tweet_id as string));
  // A tweet the database refuses is skipped and logged (lib/safeWrite.ts); the others are saved.
  const write = { runId: syncRunId, step: "x", key: (r: { tweet_id: string }) => r.tweet_id };
  const inserted = await safeWrite(db, {
    ...write,
    table: "x_tweets",
    rows: others.filter((r) => !savedIds.has(r.tweet_id)),
  });
  const insertedIds = new Set(inserted.savedIds);
  const fresh = others.filter((r) => insertedIds.has(r.tweet_id));
  // Our latest posts are refreshed every day for their engagement.
  const { data: postRows, error: e1 } = await db
    .from("x_tweets")
    .select("tweet_id")
    .in(
      "tweet_id",
      ownPosts.map((r) => r.tweet_id),
    );
  if (e1) throw new Error(`x_tweets select: ${e1.message}`);
  const knownPosts = new Set(postRows.map((r) => r.tweet_id as string));
  const upserted = await safeWrite(db, {
    ...write,
    table: "x_tweets",
    rows: ownPosts,
    mode: "upsert",
    onConflict: "tweet_id",
  });
  const followerRows = followers != null ? [{ handle: X_HANDLE, date: istDate(), followers }] : [];
  const followerWrite = await safeWrite(db, {
    ...write,
    table: "x_follower_snapshots",
    rows: followerRows,
    key: (r) => `${r.handle} ${r.date}`,
    mode: "upsert",
    onConflict: "handle,date",
  });
  summary.writes = [inserted, upserted, followerWrite];
  if (followers == null && includePosts) {
    notes.push("No follower count returned");
  }

  // A flagged mention is handled once @MontraElectric replies to it.
  const answered = answeredBy(rows);
  let autoHandled = 0;
  for (const [id, at] of answered) {
    const { data, error } = await db
      .from("x_tweets")
      .update({ handled: true, handled_at: at ?? now, handled_by: "auto" })
      .eq("tweet_id", id)
      .eq("needs_response", true)
      .eq("handled", false)
      .is("handled_by", null) // never overrides a mark (or un-mark) set by the team
      .select("tweet_id");
    if (error) throw new Error(`x_tweets auto-handle: ${error.message}`);
    autoHandled += data.length;
  }
  if (autoHandled) notes.push(`${autoHandled} flagged X mentions marked handled after a Resonia reply`);

  const newMentions = fresh.filter((r) => r.kind === "mention");
  summary.saved = {
    mentions: newMentions.length,
    posts: ownPosts.filter((r) => !knownPosts.has(r.tweet_id) && upserted.savedIds.includes(r.tweet_id)).length,
    replies: fresh.filter((r) => r.kind === "reply").length,
    recovered: newMentions.filter((r) => r.source === "reply_lookup").length,
  };
  summary.alreadySaved = others.length - fresh.length;
  summary.flagged = newMentions.filter((r) => r.needs_response).length;
  summary.media = newMentions.filter((r) => r.is_media).length;
  summary.autoHandled = autoHandled;
  summary.notes = notes.join(". ");
  return summary;
}

// Re-applies sentiment.json to stored X mentions (npm run retag-comments). "handled" is kept.
export async function retagX(db: SupabaseClient): Promise<number> {
  if (!(await xTablesReady(db))) return 0;
  const { data, error } = await db
    .from("x_tweets")
    .select("tweet_id,kind,is_media,text,sentiment,needs_response")
    .eq("kind", "mention");
  if (error) throw new Error(`x_tweets select: ${error.message}`);
  let changed = 0;
  for (const r of data) {
    const sentiment = tagSentiment(sentimentText({ id: r.tweet_id, full_text: r.text }, r.is_media));
    const flag = r.is_media ? sentiment === "Negative" : needsResponse(sentiment, false);
    if (sentiment === r.sentiment && flag === r.needs_response) continue;
    const { error: e } = await db
      .from("x_tweets")
      .update({ sentiment, needs_response: flag })
      .eq("tweet_id", r.tweet_id);
    if (e) throw new Error(`x_tweets update: ${e.message}`);
    changed++;
  }
  return changed;
}
