// X (Twitter) tracking for @MontraElectric: turns tweets from scrape.badger/twitter-tweets-scraper
// into x_tweets rows. Pure functions only (no network, no database), so tests and the
// browser can use them; the daily fetch lives in lib/xsync.ts.
import type { DashBrand } from "@/lib/dashboard";
import { needsResponse, tagSentiment } from "@/lib/sentiment";

export const X_HANDLE = "MontraElectric";
export const X_PROFILE_URL = `https://x.com/${X_HANDLE}`;

// X shows up as one more "page" in the Comments tab filter and the digest's by-page table.
export const X_BRAND: DashBrand = {
  id: "x",
  name: `X @${X_HANDLE}`,
  segment: "x",
  is_montra: true,
  sync_every_days: 1,
  last_synced_at: null,
  linkedin_url: X_PROFILE_URL,
  track_comments: true,
};
const HANDLE_LC = X_HANDLE.toLowerCase();

// One tweet as the actor returns it (only the fields we use).
export type BadgerTweet = {
  id: string;
  full_text?: string | null;
  text?: string | null;
  created_at?: string | null; // "Fri Oct 02 03:29:11 +0000 2026"
  username?: string | null;
  user_name?: string | null;
  user_description?: string | null;
  user_followers_count?: number | null;
  favorite_count?: number | null;
  reply_count?: number | null;
  retweet_count?: number | null;
  quote_count?: number | null;
  view_count?: number | null;
  in_reply_to_status_id?: string | null;
  in_reply_to_screen_name?: string | null;
  conversation_id?: string | null;
  is_retweet?: boolean | null;
  user_mentions?: { username?: string | null }[] | null;
  hashtags?: { tag?: string | null }[] | null;
  media?: unknown[] | null;
};

// mention = written by someone else; post / reply = written by @MontraElectric.
export type XKind = "mention" | "post" | "reply";
// How the tweet was found: the daily search, our own timeline, or by id because we replied to it
// (X search hides some tweets, mostly from new or low-follower accounts).
export type XSource = "search" | "own" | "reply_lookup";

export type XRow = {
  tweet_id: string;
  kind: XKind;
  source: XSource;
  author_username: string | null;
  author_name: string | null;
  author_followers: number | null;
  text: string | null;
  posted_at: string | null;
  url: string;
  in_reply_to_id: string | null;
  in_reply_to_username: string | null;
  conversation_id: string | null;
  tags_us: boolean; // tags @MontraElectric or replies to it; false = only names "Resonia"
  is_media: boolean; // a media or brand page, not a customer
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  views: number | null;
  sentiment: string;
  needs_response: boolean;
  mentions: string[]; // handles tagged in the text, masked in the public view
  last_seen_at: string;
};

const sameHandle = (a: string | null | undefined, b = HANDLE_LC) => !!a && a.toLowerCase() === b;

export function isOwn(t: Pick<BadgerTweet, "username">): boolean {
  return sameHandle(t.username);
}

export function tweetText(t: BadgerTweet): string {
  return t.full_text ?? t.text ?? "";
}

export function tweetUrl(username: string | null | undefined, id: string): string {
  return `https://x.com/${username || "i/web"}/status/${id}`;
}

// "Fri Oct 02 03:29:11 +0000 2026" -> ISO. Returns null when it cannot be read.
export function parseXDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  const m = s.match(/^\w{3} (\w{3}) (\d{2}) (\d{2}:\d{2}:\d{2}) \+0000 (\d{4})$/);
  if (!m) return null;
  const ms2 = Date.parse(`${m[1]} ${m[2]} ${m[4]} ${m[3]} UTC`);
  return Number.isNaN(ms2) ? null : new Date(ms2).toISOString();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// Handles tagged in the text (without the @), in order of appearance, @MontraElectric excluded.
export function taggedHandles(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\w@])@(\w{1,15})/g)) if (!sameHandle(m[1])) out.add(m[1]);
  return [...out];
}

export function tagsUs(t: BadgerTweet): boolean {
  if (sameHandle(t.in_reply_to_screen_name)) return true;
  if ((t.user_mentions ?? []).some((m) => sameHandle(m.username))) return true;
  return new RegExp(`(?<![\\w@])@${X_HANDLE}\\b`, "i").test(tweetText(t));
}

// Media outlets and brand pages, by their bio or name.
const MEDIA_WORDS =
  /\b(news|media|magazine|journal\w*|times|daily|weekly|digest|automotive|motoring|insights|official|reviews?|updates|articles|conference|forum|podcast|blog|channel|press|publication|portal|bureau|tv|printing)\b/i;

// Links in the text other than the one X adds for attached photos or videos.
function linkCount(t: BadgerTweet): number {
  const links = tweetText(t).match(/https?:\/\/t\.co\/\w+/g)?.length ?? 0;
  return Math.max(0, links - (t.media?.length ? 1 : 0));
}

// A tweet by a media outlet or brand page rather than a customer: its bio or name says so,
// it carries three or more hashtags, or it only names Resonia (no tag, not a reply to
// us) and shares a link or a hashtag. Our own tweets are never media mentions.
export function isMediaMention(t: BadgerTweet): boolean {
  if (isOwn(t)) return false;
  if (MEDIA_WORDS.test(`${t.user_name ?? ""} ${t.user_description ?? ""}`)) return true;
  const hashtags = t.hashtags?.length ?? tweetText(t).match(/(?<!\w)#\w+/g)?.length ?? 0;
  if (hashtags >= 3) return true;
  return !tagsUs(t) && (linkCount(t) > 0 || hashtags > 0);
}

// The text the sentiment rules see. Links are dropped (every X link is a t.co link, so
// sentiment.json's "link to another site" Spam rule would catch every news share) and so are
// the @handles X puts in front of a reply. For media mentions only the sentences that name
// Resonia count, so a news round-up is not "Negative" because of another company's story.
export function sentimentText(t: BadgerTweet, media = isMediaMention(t)): string {
  let text = decodeEntities(tweetText(t))
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^(?:\s*@\w+)+/, " ")
    .trim();
  if (media) {
    const parts = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => /montra/i.test(s));
    text = parts.join(" ");
  }
  return text;
}

export function xSentiment(t: BadgerTweet, media = isMediaMention(t)): { sentiment: string; needs_response: boolean } {
  if (isOwn(t)) return { sentiment: "Neutral", needs_response: false };
  const sentiment = tagSentiment(sentimentText(t, media));
  // Media mentions only need a response when they are negative.
  return { sentiment, needs_response: media ? sentiment === "Negative" : needsResponse(sentiment, false) };
}

export function xRow(t: BadgerTweet, source: XSource, now = new Date().toISOString()): XRow {
  const own = isOwn(t);
  const media = isMediaMention(t);
  const text = decodeEntities(tweetText(t));
  const kind: XKind = own ? (t.in_reply_to_status_id ? "reply" : "post") : "mention";
  return {
    tweet_id: String(t.id),
    kind,
    source,
    author_username: t.username ?? null,
    author_name: t.user_name ?? null,
    author_followers: t.user_followers_count ?? null,
    text,
    posted_at: parseXDate(t.created_at),
    url: tweetUrl(t.username, String(t.id)),
    in_reply_to_id: t.in_reply_to_status_id ?? null,
    in_reply_to_username: t.in_reply_to_screen_name ?? null,
    conversation_id: t.conversation_id ?? null,
    tags_us: tagsUs(t),
    is_media: media,
    likes: t.favorite_count ?? 0,
    replies: t.reply_count ?? 0,
    reposts: t.retweet_count ?? 0,
    quotes: t.quote_count ?? 0,
    views: t.view_count ?? null,
    ...xSentiment(t, media),
    mentions: taggedHandles(text),
    last_seen_at: now,
  };
}

// Tweets we replied to that are not saved or fetched yet (X search hides some of them).
export function missingParents(own: BadgerTweet[], known: Set<string>): string[] {
  const ids = new Set<string>();
  for (const t of own) {
    const parent = t.in_reply_to_status_id;
    if (parent && !sameHandle(t.in_reply_to_screen_name) && !known.has(String(parent))) ids.add(String(parent));
  }
  return [...ids];
}

// Mentions flagged "Needs response" that one of our replies answers.
export function answeredBy(
  rows: Pick<XRow, "tweet_id" | "kind" | "in_reply_to_id" | "posted_at">[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const r of rows) {
    if (r.kind === "reply" && r.in_reply_to_id && !out.has(r.in_reply_to_id)) out.set(r.in_reply_to_id, r.posted_at);
  }
  return out;
}

// Our replies sometimes go out with a template's placeholder still in them, e.g.
// "[customer_support_contact]". Flagged on the X tab so the team can follow up.
export function hasPlaceholder(text: string | null | undefined): boolean {
  return /\[[a-z]+(?:_[a-z]+)+\]/i.test(text ?? "");
}

// Public view: hide every handle except @MontraElectric and the media and brand accounts in
// `keepHandles`, and any bare username or customer name we know of (our replies start
// "Hello autowalaanna, ...").
export function maskXText(text: string, names: Iterable<string>, keepHandles: Iterable<string> = []): string {
  const keep = new Set([...keepHandles].map((h) => h.toLowerCase()));
  let out = text.replace(/(?<![\w@])@(\w{1,15})/g, (m, h: string) =>
    sameHandle(h) || keep.has(h.toLowerCase()) ? m : "@[user]",
  );
  const list = [...new Set([...names].map((n) => n.trim()).filter((n) => n.length >= 3 && !sameHandle(n)))].sort(
    (a, b) => b.length - a.length,
  );
  for (const n of list) {
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    // Hashtags (#MoreRetail) and @handles (masked above) are left alone.
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}_@#\\[])${esc}(?![\\p{L}\\p{N}_])`, "giu"), "[user]");
  }
  return out;
}
