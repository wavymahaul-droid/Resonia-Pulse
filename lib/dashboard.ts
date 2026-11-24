// Loads everything the dashboard needs in one go. Server-only (uses the service key).
// The page is small (15 pages, a few hundred posts), so filtering happens in the browser.
import { BRANDS, type Segment } from "@/lib/brands";
import { maskContacts, maskMentions, type Mention } from "@/lib/comments";
import { growthCurve } from "@/lib/analytics";
import { isVideoType } from "@/lib/liexport";
import type { RadarItem } from "@/lib/radar";
import { loadRadar } from "@/lib/radarData";
import { HISTORY_SEED, type ExportPostRow, type HistoryRow } from "@/lib/monthly";
import { signedImageUrls } from "@/lib/images";
import { supabaseAdmin } from "@/lib/supabase";
import { THEMES } from "@/lib/themes";
import { RUN_KINDS, type RunKind } from "@/lib/runs";
import { healthRuns, type HealthRun, type HealthRunRow, type SkippedItem } from "@/lib/health";
import { syncWarnings, type RunRow } from "@/lib/warnings";
import { X_BRAND, X_HANDLE, X_PROFILE_URL, hasPlaceholder, maskXText } from "@/lib/x";

export type DashBrand = {
  id: string;
  name: string;
  segment: Segment;
  is_montra: boolean;
  sync_every_days: number;
  last_synced_at: string | null;
  linkedin_url: string;
  track_comments: boolean;
};

export type DashPost = {
  url: string;
  brand: string;
  posted_at: string;
  text: string;
  theme: string;
  theme_manual: boolean; // set by hand on the dashboard
  media: string;
  image: string | null; // signed thumbnail URL
  likes: number;
  comments: number;
  reposts: number;
  as_of: string; // IST date the likes and comments were last read
  growth?: (number | null)[]; // likes + comments on days 0-7 after posting (IST), from daily snapshots
  li?: LiPostMetrics; // Resonia posts only, from an uploaded LinkedIn analytics export
  // "export": known only from an uploaded LinkedIn export (opening text, date, no posting time
  // or image). "backfill": collected once for older dates; likes and comments are the totals on
  // that day. Left out for posts the daily sync tracks.
  origin?: "export" | "backfill";
  // "Ad (not on feed)": a dark post (Direct Sponsored Content) known only from an export. Kept out of
  // every post list and stat; shown in the Reach card's "Paid ads (from export)" list.
  ad?: boolean;
  adManual?: boolean; // marked as organic or ad by hand (the automatic rule no longer applies)
};

export type LiPostMetrics = {
  impressions: number | null;
  clicks: number | null;
  ctr: number | null; // 0.0123 = 1.23%, as exported
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  engagementRate: number | null; // LinkedIn's: (reactions + comments + reposts + clicks) ÷ impressions
  video: boolean; // the export's Content Type is video (LinkedIn counts plays as clicks)
};
// Daily page numbers from uploaded LinkedIn analytics exports (Resonia pages only).
export type LiPageDay = {
  brand: string;
  date: string;
  // LinkedIn's totals (organic + sponsored), and the two parts when the export had them.
  impressions: number | null;
  clicks: number | null;
  reactions?: number | null;
  comments?: number | null;
  reposts?: number | null;
  impressions_organic?: number | null;
  impressions_sponsored?: number | null;
  clicks_organic?: number | null;
  clicks_sponsored?: number | null;
  reactions_organic?: number | null;
  reactions_sponsored?: number | null;
  comments_organic?: number | null;
  comments_sponsored?: number | null;
  reposts_organic?: number | null;
  reposts_sponsored?: number | null;
  new_followers: number | null; // LinkedIn's total new followers that day
  new_followers_organic?: number | null;
  new_followers_sponsored?: number | null;
  page_views: number | null;
  unique_visitors: number | null;
  engagement_rate?: number | null; // LinkedIn's daily rate (All view)
};
export type LiExportData = {
  ready: boolean; // false until supabase/schema.sql adds the LinkedIn analytics tables
  split: boolean; // false until schema.sql adds the organic / sponsored columns
  lastUploaded: string | null; // ISO time of the latest upload
  pages: LiPageDay[];
};

// In public view (PUBLIC_DASHBOARD=true and not signed in) people's names, headlines, profile links
// and the links to their comments, posts and tweets are removed (those URLs contain the person's
// name or handle) and phone numbers / emails in the text are masked, on the server. Links stay for
// our own pages and @MontraElectric, and for Media mentions (company, media and brand accounts),
// which are also shown by name.
export type DashComment = {
  id: string;
  post_url: string;
  brand: string;
  parent: string | null;
  name: string; // "LinkedIn member" in public view (the page name for Resonia's own replies)
  headline: string | null;
  profile: string | null;
  page_reply: boolean;
  text: string;
  posted_at: string | null;
  reactions: number;
  url: string | null;
  sentiment: string;
  needs_response: boolean;
  handled: boolean;
  handled_by: string | null;
  channel?: "x" | "li_mention"; // X mentions and replies, or LinkedIn mentions; LinkedIn comments leave it out
  media?: boolean; // "Media mention": a media or brand page, flagged only when Negative
  x?: XInfo;
  li?: { comments: number; reposts: number; staff: boolean }; // LinkedIn mentions only
};

export type XInfo = {
  replies: number;
  reposts: number;
  views: number | null;
  followers: number | null; // the author's; null in public view
  recovered: boolean; // hidden from X search, found because we replied to it
  placeholder: boolean; // our reply still has a template placeholder such as [customer_support_contact]
};

// Our own X posts, latest first.
export type DashXPost = {
  id: string;
  url: string;
  posted_at: string | null;
  text: string;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  views: number | null;
};

export type XData = {
  ready: boolean; // false until supabase/schema.sql has been re-run with the x_tweets table
  handle: string;
  profileUrl: string;
  posts: DashXPost[];
  followers: { date: string; followers: number }[];
};

export type FollowerPoint = { brand: string; date: string; followers: number };

export type LastRun = {
  id?: number;
  kind?: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  pages_failed: string[];
  notes: string | null;
} | null;

export type DashboardData = {
  generatedAt: string;
  trackingSince: string | null; // first day a sync ran; earlier posts are only the latest 5-10 per page
  brands: DashBrand[];
  posts: DashPost[]; // posts on the pages' feeds (no ads)
  ads: DashPost[]; // Resonia ads known only from exports ("Ad (not on feed)")
  canMarkAds: boolean; // false until schema.sql adds posts.is_ad / ad_manual
  radar: RadarItem[]; // latest Industry Radar headlines (no notes), for the Overview
  followers: FollowerPoint[];
  themes: string[];
  lastRun: LastRun; // the latest evening run
  lastRuns: Record<RunKind, LastRun>; // latest finished morning, afternoon and evening run
  canEditThemes: boolean; // false until supabase/schema.sql has been re-run
  comments: DashComment[];
  commentsReady: boolean; // false until supabase/schema.sql has been re-run with the comments table
  publicView: boolean;
  x: XData;
  warnings: string[]; // problems with the daily sync, in plain English; only sent to signed-in viewers
  // "Sync health (7 days)" and the items the sync skipped; signed-in viewers only (null otherwise).
  health: { runs: HealthRun[]; skipped: SkippedItem[]; rejectsReady: boolean } | null;
  // Video insights: transcripts from the daily run (scripts/video-pilot.ts --daily); signed-in viewers only (null otherwise).
  videoInsights: VideoInsight[] | null;
  loadedSince: string; // data is loaded from here; an earlier date range reloads the page
  liExport: LiExportData;
};

type PostRow = {
  post_url: string;
  brand_id: string;
  posted_at: string;
  text: string | null;
  theme: string | null;
  media_type: string | null;
  likes: number;
  comments: number;
  reposts: number;
  snapshot_date: string;
  image_path?: string | null;
  theme_manual?: boolean;
  origin?: string | null;
  is_ad?: boolean;
  ad_manual?: boolean;
};

const POST_COLS = "post_url,brand_id,posted_at,text,theme,media_type,likes,comments,reposts,snapshot_date";

const MAX_DAYS = 90;
const PAGE = 1000;

async function all<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
) {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

// An ad (not on the feed): set by hand, or else labelled when created from an export.
export const isAd = (p: { origin?: string | null; is_ad?: boolean; ad_manual?: boolean }) =>
  p.ad_manual ? !!p.is_ad : p.origin === "ad";

const KNOWN = new Set(BRANDS.map((b) => b.slug));
const known = (id: string) => KNOWN.has(id);

// Until supabase/schema.sql is re-run the view has no image_path / theme_manual, so fall back.
export async function loadPosts(db: ReturnType<typeof supabaseAdmin>, since: string) {
  const query = (cols: string) =>
    all<PostRow>(
      (from, to) =>
        db
          .from("post_latest")
          .select(cols)
          .gte("posted_at", since)
          .order("posted_at", { ascending: false })
          .range(from, to) as unknown as PromiseLike<{ data: PostRow[] | null; error: { message: string } | null }>,
    );
  // Each schema.sql re-run adds columns; older databases fall back step by step.
  try {
    return {
      rows: await query(`${POST_COLS},image_path,theme_manual,origin,is_ad,ad_manual`),
      migrated: true,
      ads: true,
    };
  } catch {}
  try {
    return { rows: await query(`${POST_COLS},image_path,theme_manual,origin`), migrated: true };
  } catch {
    try {
      return { rows: await query(`${POST_COLS},image_path,theme_manual`), migrated: true };
    } catch {
      return { rows: await query(POST_COLS), migrated: false };
    }
  }
}

type CommentRow = {
  comment_id: string;
  post_url: string;
  brand_id: string;
  parent_comment_id: string | null;
  commenter_name: string | null;
  commenter_headline: string | null;
  commenter_url: string | null;
  is_page_reply: boolean;
  text: string | null;
  posted_at: string | null;
  reactions: number;
  comment_url: string | null;
  sentiment: string;
  needs_response: boolean;
  handled: boolean;
  handled_by: string | null;
  mentions?: Mention[] | null; // missing until schema.sql adds the column
};

const BRAND_NAME = new Map(BRANDS.map((b) => [b.slug, b.name]));

export function toDashComment(c: CommentRow, publicView: boolean): DashComment {
  const pageName = c.is_page_reply ? (c.commenter_name ?? BRAND_NAME.get(c.brand_id) ?? "Resonia") : null;
  return {
    id: c.comment_id,
    post_url: c.post_url,
    brand: c.brand_id,
    parent: c.parent_comment_id,
    name: publicView ? (pageName ?? "LinkedIn member") : (c.commenter_name ?? "LinkedIn member"),
    headline: publicView ? null : c.commenter_headline,
    profile: publicView ? null : c.commenter_url,
    page_reply: c.is_page_reply,
    text: publicView ? maskContacts(maskMentions(c.text ?? "", c.mentions)) : (c.text ?? ""),
    posted_at: c.posted_at,
    reactions: c.reactions,
    // A person's comment link stays signed-in only; a comment by one of our own pages is public.
    url: publicView && !c.is_page_reply ? null : c.comment_url,
    sentiment: c.sentiment,
    needs_response: c.needs_response,
    handled: c.handled,
    handled_by: c.handled_by,
  };
}

// Comments on the tracked Resonia pages since `since`. Empty until schema.sql adds the table.
export async function loadComments(
  db: ReturnType<typeof supabaseAdmin>,
  since: string,
  publicView: boolean,
): Promise<{ comments: DashComment[]; ready: boolean }> {
  try {
    const rows = await all<CommentRow>((from, to) =>
      db
        .from("comments")
        .select("*") // includes mentions once schema.sql has added it
        .gte("posted_at", since)
        .order("posted_at", { ascending: false })
        .range(from, to),
    );
    return { comments: rows.filter((c) => known(c.brand_id)).map((c) => toDashComment(c, publicView)), ready: true };
  } catch {
    return { comments: [], ready: false };
  }
}

type XTweetRow = {
  tweet_id: string;
  kind: "mention" | "post" | "reply";
  source: string;
  author_username: string | null;
  author_name: string | null;
  author_followers: number | null;
  text: string | null;
  posted_at: string | null;
  url: string;
  in_reply_to_id: string | null;
  in_reply_to_username: string | null;
  conversation_id: string | null;
  is_media: boolean;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  views: number | null;
  sentiment: string;
  needs_response: boolean;
  handled: boolean;
  handled_by: string | null;
  mentions: string[] | null;
};

// In public view X usernames and names are hidden, and so is every handle in the text except
// @MontraElectric, plus any username or name of the people in these tweets (our replies say
// "Hello autowalaanna"). Phone numbers and emails are masked as in LinkedIn comments.
export function toDashTweet(
  t: XTweetRow,
  publicView: boolean,
  names: Set<string>,
  keepHandles: Set<string> = new Set(), // media and brand accounts: their @handles stay visible
): DashComment {
  const own = t.kind !== "mention";
  const text = t.text ?? "";
  return {
    id: `x:${t.tweet_id}`,
    post_url: `x:${t.conversation_id ?? t.tweet_id}`,
    brand: X_BRAND.id,
    parent: t.in_reply_to_id ? `x:${t.in_reply_to_id}` : null,
    // Media and brand accounts are named in public view too; people stay "X user".
    name: own ? "Resonia" : publicView && !t.is_media ? "X user" : (t.author_name ?? `@${t.author_username}`),
    headline: own ? `@${X_HANDLE}` : publicView && !t.is_media ? null : `@${t.author_username}`,
    profile: own ? X_PROFILE_URL : publicView ? null : `https://x.com/${t.author_username}`,
    page_reply: own,
    text: publicView ? maskContacts(maskXText(text, names, keepHandles)) : text,
    posted_at: t.posted_at,
    reactions: t.likes,
    // Public view links our own tweets and Media mentions (media and brand accounts); a person's
    // tweet URL names their handle, so it stays signed-in only.
    url: publicView && !own && !t.is_media ? null : t.url,
    sentiment: t.sentiment,
    needs_response: t.needs_response,
    handled: t.handled,
    handled_by: t.handled_by,
    channel: "x",
    media: t.is_media,
    x: {
      replies: t.replies,
      reposts: t.reposts,
      views: t.views,
      followers: publicView || own ? null : t.author_followers,
      recovered: t.source === "reply_lookup",
      placeholder: own && hasPlaceholder(text),
    },
  };
}

// X mentions and our replies since `since`, our posts and the follower history.
// Empty until schema.sql adds the x_tweets table.
export async function loadX(
  db: ReturnType<typeof supabaseAdmin>,
  since: string,
  publicView: boolean,
): Promise<{ comments: DashComment[]; data: XData }> {
  const none = {
    comments: [],
    data: { ready: false, handle: X_HANDLE, profileUrl: X_PROFILE_URL, posts: [], followers: [] },
  };
  try {
    const [tweets, followers] = await Promise.all([
      all<XTweetRow>((from, to) =>
        db
          .from("x_tweets")
          .select("*")
          .gte("posted_at", since)
          .order("posted_at", { ascending: false })
          .range(from, to),
      ),
      all<{ date: string; followers: number }>((from, to) =>
        db
          .from("x_follower_snapshots")
          .select("date,followers")
          .eq("handle", X_HANDLE)
          .gt("followers", 0) // X sometimes returns 0 for a tweet's author; never a real count
          .gte("date", since.slice(0, 10))
          .order("date")
          .range(from, to),
      ),
    ]);
    // Media and brand accounts are shown by name in public view; only people's names are masked.
    const media = new Set(
      tweets
        .filter((t) => t.kind === "mention" && t.is_media && t.author_username)
        .map((t) => t.author_username!.toLowerCase()),
    );
    const names = new Set<string>();
    for (const t of tweets) {
      if (t.kind === "mention" && !t.is_media) [t.author_username, t.author_name].forEach((n) => n && names.add(n));
      // Tagged handles are masked as @handles only, so a brand word such as EVIATOR stays.
      if (t.kind === "reply" && t.in_reply_to_username && !media.has(t.in_reply_to_username.toLowerCase())) {
        names.add(t.in_reply_to_username);
      }
    }
    return {
      comments: tweets.filter((t) => t.kind !== "post").map((t) => toDashTweet(t, publicView, names, media)),
      data: {
        ready: true,
        handle: X_HANDLE,
        profileUrl: X_PROFILE_URL,
        posts: tweets
          .filter((t) => t.kind === "post")
          .map((t) => ({
            id: t.tweet_id,
            url: t.url,
            posted_at: t.posted_at,
            text: t.text ?? "",
            likes: t.likes,
            replies: t.replies,
            reposts: t.reposts,
            quotes: t.quotes,
            views: t.views,
          })),
        followers,
      },
    };
  } catch {
    return none;
  }
}

type MentionDbRow = {
  mention_id: string;
  post_url: string;
  author_name: string | null;
  author_url: string | null;
  author_type: string | null;
  author_headline: string | null;
  text: string | null;
  posted_at: string | null;
  likes: number;
  comments: number;
  reposts: number;
  is_media: boolean;
  is_staff: boolean;
  sentiment: string;
  needs_response: boolean;
  handled: boolean;
  handled_by: string | null;
  mentions: Mention[] | null;
};

// LinkedIn mentions, masked in the public view like comments: no names, headlines or links,
// tagged people and contact details hidden.
export function toDashMention(m: MentionDbRow, publicView: boolean): DashComment {
  const company = m.author_type === "company";
  return {
    id: `lim:${m.mention_id}`,
    // A person's post URL names them, so in public view only company / media posts keep their link.
    post_url: publicView && !company ? `lim:${m.mention_id}` : m.post_url,

    brand: "li-mentions",
    parent: null,
    // Company, media and brand pages are named in public view too; people stay "LinkedIn member".
    name:
      publicView && !company ? "LinkedIn member" : (m.author_name ?? (company ? "LinkedIn page" : "LinkedIn member")),
    headline: publicView && !company ? null : m.author_headline, // a company's is its follower count
    profile: publicView ? null : m.author_url,
    page_reply: false,
    text: publicView ? maskContacts(maskMentions(m.text ?? "", m.mentions)) : (m.text ?? ""),
    posted_at: m.posted_at,
    reactions: m.likes,
    url: publicView && !company ? null : m.post_url,
    sentiment: m.sentiment,
    needs_response: m.needs_response,
    handled: m.handled,
    handled_by: m.handled_by,
    channel: "li_mention",
    media: m.is_media,
    li: { comments: m.comments, reposts: m.reposts, staff: m.is_staff },
  };
}

// LinkedIn mentions since `since`. Empty until schema.sql adds the linkedin_mentions table.
export async function loadMentions(
  db: ReturnType<typeof supabaseAdmin>,
  since: string,
  publicView: boolean,
): Promise<DashComment[]> {
  try {
    const rows = await all<MentionDbRow>((from, to) =>
      db
        .from("linkedin_mentions")
        .select("*")
        .gte("posted_at", since)
        .order("posted_at", { ascending: false })
        .range(from, to),
    );
    return rows.map((m) => toDashMention(m, publicView));
  } catch {
    return [];
  }
}

export type RunDbRow = RunRow & HealthRunRow & { finished_at: string | null };

// The latest 40 runs of any kind, newest first. Before schema.sql adds sync_runs.kind, every run
// counts as an evening run.
export async function loadRuns(db: ReturnType<typeof supabaseAdmin>): Promise<RunDbRow[]> {
  const cols = "id,started_at,finished_at,status,notes,pages_failed,pages_attempted,posts_saved";
  const q = (c: string) => db.from("sync_runs").select(c).order("started_at", { ascending: false }).limit(40);
  // Each schema.sql re-run adds columns; older databases fall back step by step.
  const steps = "comments_saved,x_saved,mentions_saved,x_status,mentions_status";
  for (const extra of [`kind,${steps},step_stats`, `kind,${steps}`, "kind"]) {
    const r = await q(`${extra},${cols}`);
    if (!r.error) return r.data as unknown as RunDbRow[];
  }
  const plain = await q(cols);
  if (plain.error) throw new Error(plain.error.message);
  return plain.data as unknown as RunDbRow[];
}

// One video from the pilot: Gemini's reading, and Sarvam's transcript when the pilot ran it.
export type VideoInsight = {
  postId: string;
  postUrl: string;
  platform: string;
  page: string;
  postedAt: string | null;
  thumbnail: string | null; // signed URL for our stored thumbnails, else the public image URL
  language: string | null;
  summary: string | null;
  transcriptOriginal: string | null;
  transcriptEnglish: string | null;
  onScreenText: string | null;
  brands: string[];
  tone: string | null;
  hasSpeech: boolean | null;
  confidence: string | null;
  confidenceReason: string | null;
  engine: string;
  sarvam: { engine: string; language: string | null; original: string | null; english: string | null } | null;
};

// The pilot's transcripts, newest post first. Empty until schema.sql adds video_transcripts.
async function loadVideoInsights(db: ReturnType<typeof supabaseAdmin>): Promise<VideoInsight[]> {
  const { data, error } = await db
    .from("video_transcripts")
    .select("*")
    .order("posted_at", { ascending: false })
    .limit(100);
  if (error || !data?.length) return [];
  const rows = data as Record<string, any>[];
  const paths = rows.map((r) => String(r.thumbnail_url ?? "")).filter((t) => t.startsWith("storage:"));
  const signed = await signedImageUrls(
    db,
    paths.map((t) => t.slice(8)),
  );
  const thumb = (t: string | null) => (!t ? null : t.startsWith("storage:") ? (signed.get(t.slice(8)) ?? null) : t);
  return rows
    .filter((r) => String(r.engine).startsWith("gemini:"))
    .map((r) => {
      const s = rows.find((x) => x.post_id === r.post_id && String(x.engine).startsWith("sarvam:"));
      return {
        postId: r.post_id,
        postUrl: r.post_url,
        platform: r.platform,
        page: r.page,
        postedAt: r.posted_at,
        thumbnail: thumb(r.thumbnail_url),
        language: r.language_detected,
        summary: r.summary_english,
        transcriptOriginal: r.transcript_original,
        transcriptEnglish: r.transcript_english,
        onScreenText: r.on_screen_text,
        brands: Array.isArray(r.brands_mentioned) ? r.brands_mentioned : [],
        tone: r.tone,
        hasSpeech: r.has_speech,
        confidence: r.confidence,
        confidenceReason: r.confidence_reason,
        engine: r.engine,
        sarvam: s
          ? {
              engine: s.engine,
              language: s.language_detected,
              original: s.transcript_original,
              english: s.transcript_english,
            }
          : null,
      };
    });
}

// Items the sync skipped in the last 7 days (lib/safeWrite.ts), newest first. Not ready until
// schema.sql adds sync_rejects.
async function loadSkipped(
  db: ReturnType<typeof supabaseAdmin>,
  now: Date,
): Promise<{ skipped: SkippedItem[]; ready: boolean }> {
  const { data, error } = await db
    .from("sync_rejects")
    .select("at,run_id,step,table_name,source_id,error,strikes,permanent")
    .gte("at", new Date(now.getTime() - 7 * 86_400_000).toISOString())
    .eq("cleared", false)
    .order("at", { ascending: false })
    .limit(100);
  return error ? { skipped: [], ready: false } : { skipped: data as SkippedItem[], ready: true };
}

// `since`: load from this time instead of the usual 91 days, for an older date range.
export async function loadDashboard({
  publicView = false,
  warnings = false,
  videos = warnings,
  since: from,
}: { publicView?: boolean; warnings?: boolean; videos?: boolean; since?: string } = {}): Promise<DashboardData> {
  const db = supabaseAdmin();
  const now = new Date();
  // One extra day so follower growth over 90 days has a starting point.
  const usual = new Date(now.getTime() - (MAX_DAYS + 1) * 86_400_000).toISOString();
  const since = from && from < usual ? from : usual;

  const [brandRows, posts, followers, runs, firstSnap, comments, x, liMentions] = await Promise.all([
    db.from("brands").select("id,last_synced_at"),
    loadPosts(db, since),
    all<{ brand_id: string; date: string; followers: number }>((from, to) =>
      db
        .from("follower_snapshots")
        .select("brand_id,date,followers")
        .gte("date", since.slice(0, 10))
        .order("date")
        .range(from, to),
    ),
    loadRuns(db),
    db.from("follower_snapshots").select("date").order("date").limit(1),
    loadComments(db, since, publicView),
    loadX(db, since, publicView),
    loadMentions(db, since, publicView),
  ]);
  if (brandRows.error) throw new Error(brandRows.error.message);
  const [li, radar, skipped, videoInsights] = await Promise.all([
    loadLiExport(db, since),
    // Notes are left out here: the Overview shows headlines only.
    loadRadar(db, { publicView: true, limit: 80 }),
    warnings ? loadSkipped(db, now) : null,
    videos ? loadVideoInsights(db) : null, // signed-in viewers only
  ]);
  const lastRuns = Object.fromEntries(
    RUN_KINDS.map((k) => [k, runs.find((r) => (r.kind ?? "evening") === k && r.status !== "running") ?? null]),
  ) as Record<RunKind, LastRun>;

  const ownPosts = posts.rows.filter((p) => known(p.brand_id));
  const [images, snaps] = await Promise.all([
    signedImageUrls(
      db,
      ownPosts.map((p) => p.image_path).filter((x): x is string => !!x),
    ),
    // Daily likes + comments per post, for the growth curves (days 0-7 after posting).
    all<{ post_url: string; date: string; likes: number; comments: number }>((from, to) =>
      db
        .from("post_snapshots")
        .select("post_url,date,likes,comments")
        .gte("date", since.slice(0, 10))
        .order("post_url")
        .order("date")
        .range(from, to),
    ),
  ]);
  const snapsByPost = new Map<string, { date: string; likes: number; comments: number }[]>();
  for (const s of snaps) snapsByPost.set(s.post_url, [...(snapsByPost.get(s.post_url) ?? []), s]);

  const dashPosts: DashPost[] = ownPosts.map((p) => ({
    url: p.post_url,
    brand: p.brand_id,
    posted_at: p.posted_at,
    text: p.text ?? "",
    theme: p.theme ?? "Other",
    theme_manual: p.theme_manual ?? false,
    media: p.media_type ?? "text",
    image: (p.image_path && images.get(p.image_path)) || null,
    likes: p.likes,
    comments: p.comments,
    reposts: p.reposts,
    as_of: p.snapshot_date,
    growth: growthCurve(p.posted_at, snapsByPost.get(p.post_url) ?? []),
    li: li.posts.get(p.post_url),
    // "ad": an export row that matched no feed post and is marked sponsored or has no feed link.
    ...(p.origin === "export" || p.origin === "backfill" || p.origin === "ad"
      ? { origin: p.origin === "ad" ? "export" : p.origin }
      : {}),
    ...(isAd(p) ? { ad: true } : {}),
    ...(p.ad_manual ? { adManual: true } : {}),
  }));

  const lastSynced = new Map((brandRows.data ?? []).map((r) => [r.id as string, r.last_synced_at as string | null]));

  return {
    generatedAt: now.toISOString(),
    trackingSince: firstSnap.data?.[0]?.date ?? null,
    brands: BRANDS.map((b) => ({
      id: b.slug,
      name: b.name,
      segment: b.segment,
      is_montra: b.is_montra,
      sync_every_days: b.sync_every_days,
      last_synced_at: lastSynced.get(b.slug) ?? null,
      linkedin_url: b.linkedin_url,
      track_comments: !!b.track_comments,
    })),
    // Pages removed from brands.json drop out of the dashboard but stay in the database.
    // Ads (not on the feed) are kept apart from every post list.
    posts: dashPosts.filter((p) => !p.ad),
    ads: dashPosts.filter((p) => p.ad),
    canMarkAds: "ads" in posts,
    radar: radar.items,
    followers: followers
      .filter((f) => known(f.brand_id))
      .map((f) => ({ brand: f.brand_id, date: f.date, followers: f.followers })),
    themes: THEMES,
    lastRun: lastRuns.evening,
    lastRuns,
    canEditThemes: posts.migrated,
    comments: [...comments.comments, ...x.comments, ...liMentions],
    commentsReady: comments.ready,
    publicView,
    x: x.data,
    loadedSince: since,
    liExport: li.data,
    warnings: warnings
      ? syncWarnings(
          runs,
          BRANDS.map((b) => ({ id: b.slug, name: b.name })),
          now,
        )
      : [],
    videoInsights,
    health: skipped ? { runs: healthRuns(runs, now), skipped: skipped.skipped, rejectsReady: skipped.ready } : null,
  };
}

// Uploaded LinkedIn analytics exports: per-post numbers for tracked posts, daily page numbers
// since `since`, and when the last file was uploaded. Empty until schema.sql adds the tables.
async function loadLiExport(
  db: ReturnType<typeof supabaseAdmin>,
  since: string,
): Promise<{ posts: Map<string, LiPostMetrics>; data: LiExportData }> {
  const empty = {
    posts: new Map<string, LiPostMetrics>(),
    data: { ready: false, split: false, lastUploaded: null, pages: [] },
  };
  const last = await db.from("li_uploads").select("uploaded_at").order("uploaded_at", { ascending: false }).limit(1);
  if (last.error) return empty;
  // Organic / sponsored columns arrive with a later schema.sql; read without them until then.
  const split = !(await db.from("li_page_metrics").select("impressions_organic").limit(1)).error;
  const SPLIT = ["impressions", "clicks", "reactions", "comments", "reposts", "new_followers"]
    .flatMap((k) => [`${k}_organic`, `${k}_sponsored`])
    .join(",");
  type PostRow = {
    post_url: string;
    impressions: number | null;
    clicks: number | null;
    ctr: number | string | null;
    reactions: number | null;
    comments: number | null;
    reposts: number | null;
    engagement_rate: number | string | null;
    raw?: Record<string, unknown> | null;
  };
  const postCols: string = `post_url,impressions,clicks,ctr,reactions,comments,reposts,engagement_rate${split ? ",raw" : ""}`;
  const dayCols: string = `brand_id,date,impressions,clicks,reactions,comments,reposts,engagement_rate,new_followers,page_views,unique_visitors${split ? `,${SPLIT}` : ""}`;
  const [posts, pages] = await Promise.all([
    all<PostRow>((from, to) =>
      db
        .from("li_post_metrics")
        .select(postCols)
        .not("post_url", "is", null)
        .order("post_url")
        .range(from, to)
        .returns<PostRow[]>(),
    ),
    all<Omit<LiPageDay, "brand"> & { brand_id: string }>((from, to) =>
      db
        .from("li_page_metrics")
        .select(dayCols)
        .gte("date", since.slice(0, 10))
        .order("date")
        .range(from, to)
        .returns<(Omit<LiPageDay, "brand"> & { brand_id: string })[]>(),
    ),
  ]);
  const num = (v: number | string | null) => (v == null ? null : Number(v));
  return {
    posts: new Map(
      posts.map((p) => [
        p.post_url,
        {
          impressions: p.impressions,
          clicks: p.clicks,
          ctr: num(p.ctr),
          reactions: p.reactions,
          comments: p.comments,
          reposts: p.reposts,
          engagementRate: num(p.engagement_rate),
          video: isVideoType(p.raw?.["Content Type"]),
        },
      ]),
    ),
    data: {
      ready: true,
      split,
      lastUploaded: last.data?.[0]?.uploaded_at ?? null,
      pages: pages
        .filter((p) => known(p.brand_id))
        .map(({ brand_id, ...p }) => ({
          brand: brand_id,
          ...p,
          engagement_rate: p.engagement_rate == null ? null : Number(p.engagement_rate),
        })),
    },
  };
}

export type DigestData = {
  generatedAt: string;
  brands: DashBrand[]; // the pages with comment tracking
  posts: DashPost[]; // their posts, without thumbnails
  comments: DashComment[];
  commentsReady: boolean;
  publicView: boolean;
  x: XData;
  loadedSince: string; // data is loaded from here; an earlier date range reloads the page
};

// Data for the ORM digest page: comments and posts of the tracked Resonia pages, last 90 days.
export async function loadDigest({
  publicView = false,
  since: from,
}: { publicView?: boolean; since?: string } = {}): Promise<DigestData> {
  const db = supabaseAdmin();
  const now = new Date();
  const usual = new Date(now.getTime() - MAX_DAYS * 86_400_000).toISOString();
  const since = from && from < usual ? from : usual;
  const tracked = BRANDS.filter((b) => b.track_comments);
  const [comments, posts, x, liMentions] = await Promise.all([
    loadComments(db, since, publicView),
    all<PostRow>((from, to) =>
      db
        .from("post_latest")
        .select(POST_COLS)
        .in(
          "brand_id",
          tracked.map((b) => b.slug),
        )
        .neq("origin", "ad")
        .gte("posted_at", new Date(now.getTime() - 365 * 86_400_000).toISOString())
        .range(from, to),
    ),
    loadX(db, since, publicView),
    loadMentions(db, since, publicView),
  ]);
  return {
    generatedAt: now.toISOString(),
    // X is listed after the LinkedIn pages.
    brands: [
      ...tracked.map((b) => ({
        id: b.slug,
        name: b.name,
        segment: b.segment,
        is_montra: b.is_montra,
        sync_every_days: b.sync_every_days,
        last_synced_at: null,
        linkedin_url: b.linkedin_url,
        track_comments: true,
      })),
      ...(x.data.ready ? [X_BRAND] : []),
    ],
    posts: posts.map((p) => ({
      url: p.post_url,
      brand: p.brand_id,
      posted_at: p.posted_at,
      text: p.text ?? "",
      theme: p.theme ?? "Other",
      theme_manual: false,
      media: p.media_type ?? "text",
      image: null,
      likes: p.likes,
      comments: p.comments,
      reposts: p.reposts,
      as_of: p.snapshot_date,
    })),
    comments: [...comments.comments, ...x.comments, ...liMentions],
    commentsReady: comments.ready,
    publicView,
    x: x.data,
    loadedSince: since,
  };
}

// For the monthly client report: post rows of the uploaded Content exports (to count posts as
// LinkedIn lists them) and the month-on-month history entered from earlier decks. Until
// schema.sql adds report_history, the history built into lib/monthly.ts is used (read-only).
export async function loadMonthly(): Promise<{
  exportPosts: ExportPostRow[];
  history: HistoryRow[];
  historyReady: boolean;
}> {
  const db = supabaseAdmin();
  type HistDb = {
    brand_id: string;
    month: string;
    follower_growth: number | null;
    engagement: number | null;
    impressions: number | null;
    posts: number | null;
    follower_growth_from_export?: boolean;
  };
  const histCols = "brand_id,month,follower_growth,engagement,impressions,posts";
  const [posts, withFlag] = await Promise.all([
    db.from("li_post_metrics").select("brand_id,created_date").limit(10000),
    db.from("report_history").select(`${histCols},follower_growth_from_export`).returns<HistDb[]>(),
  ]);
  // follower_growth_from_export arrives with a later schema.sql.
  const hist = withFlag.error ? await db.from("report_history").select(histCols).returns<HistDb[]>() : withFlag;
  return {
    exportPosts: (posts.data ?? []).map((p) => ({
      brand: p.brand_id as string,
      created: p.created_date as string | null,
    })),
    historyReady: !hist.error,
    history: hist.error
      ? HISTORY_SEED
      : (hist.data ?? []).map((h) => ({
          brand: h.brand_id,
          month: h.month,
          followerGrowth: h.follower_growth,
          engagement: h.engagement,
          impressions: h.impressions,
          posts: h.posts,
          followerGrowthFromExport: !!h.follower_growth_from_export,
        })),
  };
}
