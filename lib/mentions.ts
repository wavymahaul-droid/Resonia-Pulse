// LinkedIn mentions: public posts by others that name Resonia, found with the no-cookie actor
// harvestapi/linkedin-post-search ($0.002 per post returned, $0.001 for a search with no result).
// Runs last in the daily sync, after posts, comments and X, and only spends what they leave.
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRANDS } from "@/lib/brands";
import { PRICE_PER_POST_USD, billingCycle, runActor, slugFromUrl } from "@/lib/apify";
import { personMentions, postReserveUsd, type Mention } from "@/lib/comments";
import { istMidnight, lastStepSuccess, windowStart } from "@/lib/runs";
import { needsResponse, tagSentiment } from "@/lib/sentiment";
import { safeWrite, type WriteResult } from "@/lib/safeWrite";

const ACTOR = "harvestapi~linkedin-post-search";
// One search covers all five names: the Truck, SCV and Tractor page names contain "Resonia".
export const MENTION_QUERY = '"Resonia" OR EViator';
export const PRICE_PER_MENTION_USD = 0.002;
// Our own four pages post the same update on each page and show up in the search too; they are
// skipped but still charged, so the fetch leaves room for a few of them.
export const OWN_POST_ALLOWANCE = 3;
const RUN_START_USD = 0.00005;
// The actor refuses a spending cap below $0.01.
const MIN_CAP_USD = 0.01;

// At most 8 new mentions are saved a day across the morning, afternoon and evening searches, and
// at most 11 posts are fetched (8 plus room for our own pages' posts). On top of that the day's
// fetch is sized to what the budget can still pay for, so even a day that hits every limit
// keeps the month under APIFY_MONTHLY_BUDGET_USD.
export const MAX_NEW_PER_DAY = 8;
export const MAX_FETCH_PER_DAY = MAX_NEW_PER_DAY + OWN_POST_ALLOWANCE;
// Worst-case extras a day: three run starts, and up to two searches that find nothing ($0.001 each).
export const MENTION_EXTRAS_PER_DAY_USD = 3 * RUN_START_USD + 2 * 0.001;
// Set aside a day for the steps that come before mentions (three X searches; comments). Measured
// 7-9 Oct 2026: X about $0.0018 a day, comments about $0.0027 a day.
export const X_PER_DAY_USD = 0.002;
export const COMMENTS_PER_DAY_USD = 0.003;

// Posts the mention searches may fetch in a day when `allowanceUsd` a day is left for them.
export function dailyFetchCap(allowanceUsd: number): number {
  const n = Math.floor((allowanceUsd - MENTION_EXTRAS_PER_DAY_USD) / PRICE_PER_MENTION_USD + 1e-9);
  return Math.max(0, Math.min(MAX_FETCH_PER_DAY, n));
}

// Worst case for a normal 30.4-day month: LinkedIn posts at each page's usual max_posts,
// comments, X three times a day, and the mention searches fetching `fetchPerDay` posts a day.
export function normalMonthUsd(fetchPerDay = MAX_FETCH_PER_DAY): number {
  const posts = BRANDS.reduce((s, b) => s + (b.max_posts * PRICE_PER_POST_USD) / b.sync_every_days, 0);
  const mentions = fetchPerDay * PRICE_PER_MENTION_USD + MENTION_EXTRAS_PER_DAY_USD;
  return 30.4 * (posts + COMMENTS_PER_DAY_USD + X_PER_DAY_USD + mentions);
}

export type ApifySearchPost = {
  id: string;
  type?: string;
  linkedinUrl: string;
  content?: string | null;
  postedAt?: { date?: string } | null;
  author?: {
    type?: string | null; // company / profile
    name?: string | null;
    universalName?: string | null;
    publicIdentifier?: string | null;
    linkedinUrl?: string | null;
    info?: string | null; // company: "65,001 followers"; person: headline
  } | null;
  engagement?: { likes?: number; comments?: number; shares?: number } | null;
  contentAttributes?: { start?: number; length?: number; type?: string | null; profile?: object | null }[] | null;
};

export type MentionRow = {
  mention_id: string; // LinkedIn activity id
  post_url: string;
  author_name: string | null;
  author_url: string | null;
  author_type: string | null; // company / profile
  author_headline: string | null; // a person's headline; a company's follower count
  text: string | null;
  posted_at: string | null;
  likes: number;
  comments: number;
  reposts: number;
  is_media: boolean; // a company page (media outlet or brand), shown as "Media mention"
  is_staff: boolean; // a person whose headline names Resonia / TI Clean Mobility: never flagged
  sentiment: string;
  needs_response: boolean;
  mentions: Mention[]; // tagged people, masked in the public view
  last_seen_at: string;
};

const OWN = new Set(BRANDS.filter((b) => b.is_montra).map((b) => b.slug));
const STAFF = /\b(montra|ti clean mobility|tivolt|tube investments)\b/i;

export function isOwnPage(p: ApifySearchPost): boolean {
  const slug = p.author?.universalName?.toLowerCase() ?? slugFromUrl(p.author?.linkedinUrl);
  return !!slug && OWN.has(slug);
}

// Media and brand posts are judged only on their sentences that name Resonia (as for X).
export function mentionSentimentText(text: string, media: boolean): string {
  const t = text.normalize("NFKC");
  if (!media) return t;
  return t
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((s) => /montra|eviator/i.test(s))
    .join(" ");
}

export function mentionRow(p: ApifySearchPost, now = new Date().toISOString()): MentionRow {
  const company = p.author?.type === "company";
  const headline = p.author?.info?.trim() || null;
  const staff = !company && STAFF.test(headline ?? "");
  const text = p.content ?? "";
  const sentiment = staff ? "Neutral" : tagSentiment(mentionSentimentText(text, company));
  return {
    mention_id: String(p.id),
    post_url: p.linkedinUrl,
    author_name: p.author?.name ?? null,
    author_url: p.author?.linkedinUrl?.replace(/[?#].*$/, "").replace(/\/posts\/?$/, "/") ?? null,
    author_type: p.author?.type ?? null,
    author_headline: headline,
    text,
    posted_at: p.postedAt?.date ?? null,
    likes: p.engagement?.likes ?? 0,
    comments: p.engagement?.comments ?? 0,
    reposts: p.engagement?.shares ?? 0,
    is_media: company,
    is_staff: staff,
    sentiment,
    // Media and brand posts only need a response when negative; staff posts never.
    needs_response: staff ? false : company ? sentiment === "Negative" : needsResponse(sentiment, false),
    mentions: personMentions({ commentary: text, commentaryAttributes: p.contentAttributes }),
    last_seen_at: now,
  };
}

export type MentionSyncSummary = {
  status: "success" | "skipped";
  costUsd: number;
  since: string | null; // start of the search window (ISO)
  fetched: number; // posts returned (and charged), our own included
  ownSkipped: number;
  alreadySaved: number;
  saved: number;
  flagged: number;
  media: number;
  savedToday: number; // new mentions saved today (IST) before this run
  fetchLimit: number; // posts this run was allowed to fetch
  notes: string;
  rows: MentionRow[];
  writes?: WriteResult[]; // rows saved and skipped
};

export async function mentionsTableReady(db: SupabaseClient): Promise<boolean> {
  return !(await db.from("linkedin_mentions").select("mention_id").limit(1)).error;
}

// Mentions saved and posts fetched so far today (IST), across all runs.
async function todaysUse(db: SupabaseClient): Promise<{ saved: number; fetched: number; costUsd: number }> {
  const since = istMidnight();
  const [m, r] = await Promise.all([
    db.from("linkedin_mentions").select("mention_id", { count: "exact", head: true }).gte("first_seen_at", since),
    db.from("sync_runs").select("mentions_fetched,mentions_cost_usd").gte("started_at", since),
  ]);
  const rows = (r.error ? [] : r.data) as { mentions_fetched: number | null; mentions_cost_usd: number | null }[];
  return {
    saved: m.count ?? 0,
    fetched: rows.reduce((s, x) => s + (x.mentions_fetched ?? 0), 0),
    costUsd: rows.reduce((s, x) => s + Number(x.mentions_cost_usd ?? 0), 0),
  };
}

// Posts one search may fetch. A short search (morning, afternoon) needs only the new posts still
// allowed today plus room for our own pages' posts. The evening catch-up re-reads 48 hours, where
// most posts are already saved (and still charged), so it may use the whole of what is left of
// today's fetch allowance. New saves stay within MAX_NEW_PER_DAY either way.
export function mentionFetchLimit({
  newLeft,
  fetchCap,
  fetchedToday,
  catchUp,
}: {
  newLeft: number;
  fetchCap: number;
  fetchedToday: number;
  catchUp: boolean;
}): number {
  const left = fetchCap - fetchedToday;
  return Math.max(0, catchUp ? left : Math.min(newLeft + OWN_POST_ALLOWANCE, left));
}

// Morning and afternoon: searches from the last successful mention search minus a 1-hour overlap
// (25 hours on the first run, at most 72 hours back). Evening (catchUpHours: 48): searches the last
// 48 hours, so posts that LinkedIn's search only shows some hours after they were posted are not
// lost. Already-saved posts and our own pages' posts are skipped.
export async function syncMentions(
  db: SupabaseClient | null,
  {
    budgetUsd,
    dryRun = false,
    hours,
    catchUp = false,
    includeTodaysPosts = false,
    syncRunId = null,
    maxNew,
    maxFetch,
  }: {
    budgetUsd: number;
    dryRun?: boolean;
    hours?: number; // search this many hours back instead (the evening catch-up passes 48)
    catchUp?: boolean; // the evening catch-up: may use all of today's remaining fetch allowance
    includeTodaysPosts?: boolean; // morning/afternoon scans: today's evening post sync is still to come
    syncRunId?: number | null; // sync_runs.id, for the skipped-items log
    // A backfill after missed days: save up to maxNew and fetch up to maxFetch in this one run,
    // in place of the daily limits (the budget check below still applies).
    maxNew?: number;
    maxFetch?: number;
  },
): Promise<MentionSyncSummary> {
  const skip = (notes: string, extra: Partial<MentionSyncSummary> = {}): MentionSyncSummary => ({
    status: "skipped",
    costUsd: 0,
    since: null,
    fetched: 0,
    ownSkipped: 0,
    alreadySaved: 0,
    saved: 0,
    flagged: 0,
    media: 0,
    savedToday: 0,
    fetchLimit: 0,
    notes,
    rows: [],
    ...extra,
  });
  const ready = db ? await mentionsTableReady(db) : false;
  if (!ready && !dryRun) {
    return skip("LinkedIn mentions skipped: re-run supabase/schema.sql to add the linkedin_mentions table");
  }
  const today = db && ready ? await todaysUse(db) : { saved: 0, fetched: 0, costUsd: 0 };
  const newLeft = maxNew ?? MAX_NEW_PER_DAY - today.saved;
  if (newLeft <= 0) {
    return skip(`LinkedIn mentions: today's limit of ${MAX_NEW_PER_DAY} new posts is reached`, {
      savedToday: today.saved,
    });
  }

  // Last in the budget order: the rest of the cycle's post syncs, comments and X are set aside
  // first, and what is left is spread over the remaining days (today included).
  const cycle = await billingCycle();
  const now = new Date();
  const daysLeft = Math.max(0, Math.floor((Date.parse(cycle.endsAt) - now.getTime()) / 86_400_000));
  const reserve =
    postReserveUsd(cycle.endsAt, now, { includeToday: includeTodaysPosts }) +
    (daysLeft + 1) * (COMMENTS_PER_DAY_USD + X_PER_DAY_USD);
  const headroom = budgetUsd - cycle.usageUsd - reserve;
  const perDay = (headroom + today.costUsd) / (daysLeft + 1);
  const fetchCap = dailyFetchCap(perDay);
  const fetchLimit = maxFetch ?? mentionFetchLimit({ newLeft, fetchCap, fetchedToday: today.fetched, catchUp });
  if (fetchLimit <= 0 || headroom < fetchLimit * PRICE_PER_MENTION_USD + RUN_START_USD) {
    return skip(
      fetchCap > 0 && today.fetched >= fetchCap
        ? `LinkedIn mentions: today's search limit of ${fetchCap} posts is reached`
        : `LinkedIn mentions skipped: Apify usage $${cycle.usageUsd.toFixed(2)} + $${reserve.toFixed(2)} set aside for this cycle's posts, comments and X leaves too little of the $${budgetUsd.toFixed(2)} budget`,
      { savedToday: today.saved },
    );
  }

  const last = db && ready && hours == null ? await lastStepSuccess(db, "mentions") : null;
  const sinceDate =
    hours != null
      ? new Date(now.getTime() - hours * 3_600_000)
      : windowStart(last, now, 25 * 3_600_000, 72 * 3_600_000);
  const since = sinceDate.toISOString();
  const cap = Math.max(MIN_CAP_USD, fetchLimit * PRICE_PER_MENTION_USD * 1.1 + 0.002);
  const run = await runActor<ApifySearchPost>(
    ACTOR,
    { searchQueries: [MENTION_QUERY], maxPosts: fetchLimit, postedLimitDate: since, sortBy: "date" },
    cap,
  );
  const posts = run.items.filter((p) => p?.id && p.linkedinUrl && (p.type ?? "post") === "post");
  const costUsd = Math.max(run.usageUsd, posts.length * PRICE_PER_MENTION_USD);
  const others = posts.filter((p) => !isOwnPage(p) && (!p.postedAt?.date || p.postedAt.date >= since));
  const stamp = now.toISOString();
  const rows = [...new Map(others.map((p) => [String(p.id), mentionRow(p, stamp)])).values()];

  let fresh = rows;
  if (db && ready && !dryRun && rows.length) {
    const { data, error } = await db
      .from("linkedin_mentions")
      .select("mention_id")
      .in(
        "mention_id",
        rows.map((r) => r.mention_id),
      );
    if (error) throw new Error(`linkedin_mentions select: ${error.message}`);
    const saved = new Set(data.map((r) => r.mention_id as string));
    fresh = rows.filter((r) => !saved.has(r.mention_id));
  }
  const alreadySaved = rows.length - fresh.length;
  // Newest first, within what is left of today's limit.
  fresh = fresh.sort((a, b) => Date.parse(b.posted_at ?? "") - Date.parse(a.posted_at ?? "")).slice(0, newLeft);
  // A post the database refuses is skipped and logged (lib/safeWrite.ts); the others are saved.
  let writes: WriteResult[] | undefined;
  if (db && ready && !dryRun && fresh.length) {
    const w = await safeWrite(db, {
      table: "linkedin_mentions",
      rows: fresh,
      key: (r) => r.mention_id,
      jsonColumns: ["mentions"],
      runId: syncRunId,
      step: "mentions",
    });
    writes = [w];
    const ok = new Set(w.savedIds);
    fresh = fresh.filter((r) => ok.has(r.mention_id));
  }
  const notes = [
    run.status !== "SUCCEEDED" ? `Mention search stopped early (${run.status})` : "",
    dryRun ? "Dry run: nothing saved" : "",
  ];
  return {
    status: "success",
    costUsd,
    since,
    fetched: posts.length,
    ownSkipped: posts.length - others.length,
    alreadySaved,
    saved: dryRun ? 0 : fresh.length,
    flagged: fresh.filter((r) => r.needs_response).length,
    media: fresh.filter((r) => r.is_media).length,
    savedToday: today.saved,
    fetchLimit,
    notes: notes.filter(Boolean).join(". "),
    rows: fresh,
    writes,
  };
}

// Re-applies sentiment.json to stored mentions (part of the daily re-tag). "handled" is kept.
export async function retagMentions(db: SupabaseClient): Promise<number> {
  if (!(await mentionsTableReady(db))) return 0;
  const { data, error } = await db
    .from("linkedin_mentions")
    .select("mention_id,text,is_media,is_staff,sentiment,needs_response");
  if (error) throw new Error(`linkedin_mentions select: ${error.message}`);
  let changed = 0;
  for (const r of data) {
    const sentiment = r.is_staff ? "Neutral" : tagSentiment(mentionSentimentText(r.text ?? "", r.is_media));
    const flag = r.is_staff ? false : r.is_media ? sentiment === "Negative" : needsResponse(sentiment, false);
    if (sentiment === r.sentiment && flag === r.needs_response) continue;
    const { error: e } = await db
      .from("linkedin_mentions")
      .update({ sentiment, needs_response: flag })
      .eq("mention_id", r.mention_id);
    if (e) throw new Error(`linkedin_mentions update: ${e.message}`);
    changed++;
  }
  return changed;
}
