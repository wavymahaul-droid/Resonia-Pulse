// Comment tracking for ORM on the pages with track_comments in brands.json
// (Resonia, Resonia Truck, Resonia SCV).
// Comments come from harvestapi/linkedin-post-comments (no cookies, no login), $0.002 per comment.
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRANDS, COMMENT_BRANDS, postsToFetch } from "@/lib/brands";
import { PRICE_PER_POST_USD, billingCycle, runActor, runItems, slugFromUrl } from "@/lib/apify";
import { needsResponse, tagSentiment } from "@/lib/sentiment";
import { safeWrite, type WriteResult } from "@/lib/safeWrite";

const ACTOR = "harvestapi~linkedin-post-comments";
export const PRICE_PER_COMMENT_USD = 0.002;
export const MAX_COMMENTS_PER_POST = 20;

export type ApifyComment = {
  id: string;
  linkedinUrl?: string | null;
  commentary?: string | null;
  createdAt?: string | null;
  engagement?: { likes?: number; comments?: number } | null;
  actor?: {
    name?: string | null;
    position?: string | null;
    linkedinUrl?: string | null;
    type?: string | null;
    author?: boolean | null;
  } | null;
  query?: { post?: string } | null;
  // Tagged people and companies, with their position in the text (UTF-16 offsets).
  commentaryAttributes?: { start?: number; length?: number; type?: string | null; profile?: object | null }[] | null;
  // The actor nests up to 5 replies inside each comment. The field name is not
  // documented, so both likely names are read.
  replies?: ApifyComment[] | null;
  comments?: ApifyComment[] | null;
  parentId?: string | null;
  parentCommentId?: string | null;
};

export type CommentRow = {
  comment_id: string;
  post_url: string;
  brand_id: string;
  parent_comment_id: string | null; // set for replies
  commenter_name: string | null;
  commenter_headline: string | null;
  commenter_url: string | null;
  is_page_reply: boolean; // written by a Resonia page
  text: string | null;
  posted_at: string | null;
  reactions: number;
  comment_url: string | null;
  sentiment: string;
  needs_response: boolean;
  last_seen_at: string;
  mentions: Mention[]; // tagged people, masked in the public view
};

// A tagged person: where the name sits in the text, and the name as it was written.
export type Mention = { start: number; length: number; text: string };

type Span = { start: number; length: number };

// LinkedIn gives tag positions in UTF-16 units for most posts, but in Unicode code points for some
// (seen 10 Oct 2026 on a post written in 𝐛𝐨𝐥𝐝 letters, each two UTF-16 units). Read the wrong
// way, a tag lands mid-word or on half a letter, the stored name is wrong (so the public view hid
// the wrong words) and the half letter made Postgres reject the insert. Both readings agree when
// the text has no emoji or 𝐬𝐭𝐲𝐥𝐞𝐝 letters; otherwise the one whose tags sit on word boundaries wins.
// Returns the spans as UTF-16 positions.
export function tagSpans(text: string, spans: Span[]): Span[] {
  if (!/[\uD800-\uDBFF]/.test(text) || !spans.length) return spans;
  // UTF-16 position of each code point (and of the end).
  const at: number[] = [];
  for (let i = 0; i < text.length; i += text.codePointAt(i)! > 0xffff ? 2 : 1) at.push(i);
  at.push(text.length);
  const fromCodePoints = spans.map((s) => {
    const start = at[Math.min(s.start, at.length - 1)];
    return { start, length: at[Math.min(s.start + s.length, at.length - 1)] - start };
  });
  // The whole character before and after a span (a 𝐛𝐨𝐥𝐝 letter is two UTF-16 units).
  const before = (i: number) => text.slice(/[\uDC00-\uDFFF]/.test(text[i - 1] ?? "") ? i - 2 : i - 1, i);
  const after = (i: number) => text.slice(i, /[\uD800-\uDBFF]/.test(text[i] ?? "") ? i + 2 : i + 1);
  const word = /[\p{L}\p{N}]/u;
  const fits = (list: Span[]) =>
    list.filter(
      ({ start, length }) =>
        length > 0 &&
        !word.test(before(start)) &&
        !word.test(after(start + length)) &&
        !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(text.slice(start, start + length)),
    ).length;
  return fits(fromCodePoints) > fits(spans) ? fromCodePoints : spans;
}

// People only; tagged companies (Resonia's own pages, competitors) stay visible.
export function personMentions(c: Pick<ApifyComment, "commentary" | "commentaryAttributes">): Mention[] {
  const text = c.commentary ?? "";
  const all = (c.commentaryAttributes ?? []).filter((a) => Number.isInteger(a.start) && Number.isInteger(a.length));
  // Units are decided on every tag (companies too), then only people are kept.
  const spans = tagSpans(
    text,
    all.map((a) => ({ start: a.start!, length: a.length! })),
  );
  return all
    .map((a, i) => ({ a, ...spans[i] }))
    .filter(({ a }) => a.type?.includes("PROFILE") || !!a.profile)
    .map(({ start, length }) => ({ start, length, text: text.slice(start, start + length) }))
    .filter((m) => m.length > 0 && m.text.trim().length > 0);
}

export type CommentPageResult = {
  brand: string;
  name: string;
  postsChecked: number;
  commentsSaved: number; // comments and replies stored or refreshed
  replies: number;
  pageReplies: number;
  flagged: number; // needs response, not handled
};

export type CommentSyncSummary = {
  status: "success" | "skipped" | "failed";
  costUsd: number;
  commentsSaved: number;
  autoHandled: number;
  pages: CommentPageResult[];
  runId: string | null;
  notes: string;
  writes?: WriteResult[]; // rows saved and skipped per table
};

const MONTRA_SLUGS = new Set(BRANDS.filter((b) => b.is_montra).map((b) => b.slug));

// "…?commentUrn=urn:li:comment:(activity:1,2)&replyUrn=urn:li:comment:(activity:1,3)" -> parent "2"
function parentFromUrl(url: string | null | undefined): string | null {
  if (!url || !/[?&]replyUrn=/.test(url)) return null;
  const m = decodeURIComponent(url).match(/commentUrn=urn:li:comment:\((?:activity|ugcPost|share):\d+,(\d+)\)/);
  return m?.[1] ?? null;
}

function isPageReply(c: ApifyComment): boolean {
  if (c.actor?.author) return true;
  const slug = slugFromUrl(c.actor?.linkedinUrl);
  return !!slug && MONTRA_SLUGS.has(slug);
}

// One row per comment and per nested reply.
export function commentRows(
  items: ApifyComment[],
  brandOf: (postUrl: string) => string | undefined,
  now = new Date().toISOString(),
): CommentRow[] {
  const out = new Map<string, CommentRow>();
  const walk = (c: ApifyComment, postUrl: string | undefined, parent: string | null) => {
    if (!c?.id || !postUrl) return;
    const brand = brandOf(postUrl);
    if (!brand) return;
    const page = isPageReply(c);
    const sentiment = page ? "Neutral" : tagSentiment(c.commentary);
    const headline = c.actor?.position?.trim();
    out.set(String(c.id), {
      comment_id: String(c.id),
      post_url: postUrl,
      brand_id: brand,
      parent_comment_id: parent ?? c.parentCommentId ?? c.parentId ?? parentFromUrl(c.linkedinUrl),
      commenter_name: c.actor?.name ?? null,
      commenter_headline: headline && headline !== "--" ? headline : null,
      commenter_url: c.actor?.linkedinUrl ?? null,
      is_page_reply: page,
      text: c.commentary ?? null,
      posted_at: c.createdAt ?? null,
      reactions: c.engagement?.likes ?? 0,
      comment_url: c.linkedinUrl ?? null,
      sentiment,
      needs_response: needsResponse(sentiment, page),
      last_seen_at: now,
      mentions: personMentions(c),
    });
    for (const r of [...(c.replies ?? []), ...(c.comments ?? [])]) {
      if (r && typeof r === "object") walk(r, postUrl, String(c.id));
    }
  };
  for (const c of items) walk(c, c.query?.post ?? undefined, null);
  return [...out.values()];
}

// Projected cost of the post syncs still to run before the billing cycle ends.
// Each remaining run is priced for its own day, so the competitors' 3-post saving until 4 Nov counts.
// includeToday: the morning and afternoon scans run before today's evening post sync, so they set
// that one aside too.
export function postReserveUsd(endsAt: string, now = new Date(), { includeToday = false } = {}): number {
  const runsLeft = Math.max(0, Math.floor((Date.parse(endsAt) - now.getTime()) / 86_400_000));
  const ist = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
  let total = 0;
  for (let i = includeToday ? 0 : 1; i <= runsLeft; i++) {
    const day = ist.format(new Date(now.getTime() + i * 86_400_000));
    total += BRANDS.reduce((sum, b) => sum + (postsToFetch(b, day) * PRICE_PER_POST_USD) / b.sync_every_days, 0) + 0.001;
  }
  return total;
}

type Candidate = { post_url: string; brand_id: string; comments: number; posted_at: string | null };

// Posts on tracked pages whose comment count (latest snapshot) went up since comments were last fetched.
// Before supabase/schema.sql is re-run (dry runs only) every post with comments counts.
async function candidates(db: SupabaseClient, migrated: boolean): Promise<Candidate[]> {
  const { data, error } = await db
    .from("post_latest")
    .select(`post_url,brand_id,comments,posted_at${migrated ? ",comments_checked" : ""}`)
    .in(
      "brand_id",
      COMMENT_BRANDS.map((b) => b.slug),
    )
    .gt("comments", 0)
    .order("posted_at", { ascending: false });
  if (error) throw new Error(`post_latest select: ${error.message}`);
  return (data as unknown as (Candidate & { comments_checked?: number | null })[]).filter(
    (p) => p.comments > (p.comments_checked ?? 0),
  );
}

// Flagged comments are marked handled once a Resonia page replies in the same thread
// (to the comment itself, or after it under the same top-level comment).
export async function autoHandle(db: SupabaseClient, postUrls: string[]): Promise<number> {
  if (!postUrls.length) return 0;
  const { data, error } = await db
    .from("comments")
    .select("comment_id,parent_comment_id,posted_at")
    .in("post_url", postUrls)
    .eq("is_page_reply", true)
    .not("parent_comment_id", "is", null);
  if (error) throw new Error(`comments select: ${error.message}`);
  let handled = 0;
  for (const reply of data) {
    const thread = reply.parent_comment_id as string;
    let q = db
      .from("comments")
      .update({ handled: true, handled_at: reply.posted_at ?? new Date().toISOString(), handled_by: "auto" })
      .or(`comment_id.eq.${thread},parent_comment_id.eq.${thread}`)
      .eq("needs_response", true)
      .eq("handled", false)
      .is("handled_by", null) // never overrides a mark (or un-mark) set by the team
      .eq("is_page_reply", false);
    if (reply.posted_at) q = q.lte("posted_at", reply.posted_at);
    const { data: rows, error: e } = await q.select("comment_id");
    if (e) throw new Error(`comments auto-handle: ${e.message}`);
    handled += rows.length;
  }
  return handled;
}

export async function commentsTableReady(db: SupabaseClient): Promise<boolean> {
  const [a, b] = await Promise.all([
    db.from("comments").select("comment_id").limit(1),
    db.from("post_latest").select("comments_checked").limit(1),
  ]);
  return !a.error && !b.error;
}

// Runs after the posts sync and shares its monthly Apify budget. Posts come first: the
// step only spends what is left after setting aside the cost of the rest of the
// cycle's post syncs. fromRunId re-reads a finished Apify run instead (free).
export async function syncComments(
  db: SupabaseClient,
  {
    budgetUsd,
    dryRun = false,
    fromRunId,
    ignoreReserve = false,
    syncRunId = null,
  }: { budgetUsd: number; dryRun?: boolean; fromRunId?: string; ignoreReserve?: boolean; syncRunId?: number | null },
): Promise<CommentSyncSummary> {
  const pagesFor = (posts: Candidate[], rows: CommentRow[]): CommentPageResult[] =>
    COMMENT_BRANDS.map((b) => {
      const mine = rows.filter((r) => r.brand_id === b.slug);
      return {
        brand: b.slug,
        name: b.name,
        postsChecked: posts.filter((p) => p.brand_id === b.slug).length,
        commentsSaved: mine.length,
        replies: mine.filter((r) => r.parent_comment_id).length,
        pageReplies: mine.filter((r) => r.is_page_reply).length,
        flagged: mine.filter((r) => r.needs_response).length,
      };
    });
  const skip = (notes: string, posts: Candidate[] = []): CommentSyncSummary => ({
    status: "skipped",
    costUsd: 0,
    commentsSaved: 0,
    autoHandled: 0,
    pages: pagesFor(posts, []),
    runId: null,
    notes,
  });

  const migrated = await commentsTableReady(db);
  if (!migrated && !dryRun) return skip("Comments skipped: re-run supabase/schema.sql to add the comments table");

  let due = await candidates(db, migrated);
  let items: ApifyComment[];
  let costUsd = 0;
  let runId: string | null = fromRunId ?? null;
  let complete = true;
  const notes: string[] = [];
  const writes: WriteResult[] = [];

  if (fromRunId) {
    const run = await runItems<ApifyComment, { posts?: string[] }>(fromRunId);
    items = run.items;
    const { data, error } = await db
      .from("post_latest")
      .select("post_url,brand_id,comments,posted_at")
      .in("post_url", run.input.posts ?? []);
    if (error) throw new Error(`post_latest select: ${error.message}`);
    due = data as Candidate[];
  } else {
    if (!due.length) return skip("No new comments on tracked pages");
    const cycle = await billingCycle();
    const reserve = ignoreReserve ? 0 : postReserveUsd(cycle.endsAt);
    let headroom = budgetUsd - cycle.usageUsd - reserve;
    const expected = (p: Candidate) => Math.min(p.comments, MAX_COMMENTS_PER_POST) * PRICE_PER_COMMENT_USD;
    // Newest posts first; stop adding posts once the budget left is used up.
    const picked: Candidate[] = [];
    for (const p of due) {
      if (expected(p) > headroom) break;
      headroom -= expected(p);
      picked.push(p);
    }
    if (!picked.length) {
      return skip(
        `Comments skipped: Apify usage $${cycle.usageUsd.toFixed(2)} + $${reserve.toFixed(2)} set aside for the rest of this cycle's post syncs leaves too little of the $${budgetUsd.toFixed(2)} budget`,
        [],
      );
    }
    const left = due.length - picked.length;
    due = picked;
    const cap = Math.min(
      due.reduce((s, p) => s + expected(p), 0) * 1.5 + 0.01,
      Math.max(0.01, budgetUsd - cycle.usageUsd - reserve),
    );
    const run = await runActor<ApifyComment>(
      ACTOR,
      {
        posts: due.map((p) => p.post_url),
        maxItems: MAX_COMMENTS_PER_POST,
        scrapeReplies: true,
        profileScraperMode: "short",
      },
      cap,
    );
    items = run.items;
    runId = run.runId;
    complete = run.status === "SUCCEEDED";
    const topLevel = items.length;
    costUsd = Math.max(run.usageUsd, topLevel * PRICE_PER_COMMENT_USD);
    if (left) notes.push(`${left} posts left for a later run (budget)`);
  }

  const brandOf = new Map(due.map((p) => [p.post_url, p.brand_id]));
  const rows = commentRows(items, (u) => brandOf.get(u));
  const pages = pagesFor(due, rows);
  if (!complete) notes.push("Comment run stopped early (spending cap); remaining posts are retried next run");

  let autoHandled = 0;
  if (!dryRun && migrated) {
    // Until schema.sql adds comments.mentions, save without it (tagged names then stay unmasked).
    const hasMentions = !(await db.from("comments").select("mentions").limit(1)).error;
    if (!hasMentions) notes.push("Re-run supabase/schema.sql to store tagged people (comments.mentions)");
    const toSave = hasMentions ? rows : rows.map(({ mentions: _m, ...r }) => r);
    // handled, handled_at, handled_by and first_seen_at are left out so they are kept. A comment the
    // database refuses is skipped and logged (lib/safeWrite.ts); the others are saved.
    writes.push(
      await safeWrite(db, {
        table: "comments",
        rows: toSave,
        key: (r) => r.comment_id,
        mode: "upsert",
        onConflict: "comment_id",
        jsonColumns: ["mentions"],
        runId: syncRunId,
        step: "comments",
      }),
    );
    // Remember the comment count each post had, so it is only fetched again when it grows.
    const withItems = new Set(rows.map((r) => r.post_url));
    for (const p of due) {
      if (!complete && !withItems.has(p.post_url)) continue;
      const { error } = await db.from("posts").update({ comments_checked: p.comments }).eq("post_url", p.post_url);
      if (error) throw new Error(`posts comments_checked update: ${error.message}`);
    }
    autoHandled = await autoHandle(
      db,
      due.map((p) => p.post_url),
    );
    if (autoHandled) notes.push(`${autoHandled} flagged comments marked handled after a Resonia reply`);
  }

  const commentsSaved = writes.length ? writes.reduce((n, w) => n + w.saved, 0) : rows.length;
  return { status: "success", costUsd, commentsSaved, autoHandled, pages, runId, notes: notes.join(". "), writes };
}

// Re-applies sentiment.json to every stored comment. "handled" is never changed.
export async function retagComments(db: SupabaseClient): Promise<number> {
  let changed = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("comments")
      .select("comment_id,text,is_page_reply,sentiment,needs_response")
      .order("comment_id")
      .range(from, from + 999);
    if (error) throw new Error(`comments select: ${error.message}`);
    for (const c of data) {
      const sentiment = c.is_page_reply ? "Neutral" : tagSentiment(c.text);
      const flag = needsResponse(sentiment, c.is_page_reply);
      if (sentiment === c.sentiment && flag === c.needs_response) continue;
      const { error: e } = await db
        .from("comments")
        .update({ sentiment, needs_response: flag })
        .eq("comment_id", c.comment_id);
      if (e) throw new Error(`comments update: ${e.message}`);
      changed++;
    }
    if (data.length < 1000) return changed;
  }
}

// Public view: replace tagged people with "[member]". Offsets are used when the text
// still holds the name there; otherwise every copy of the name is replaced. A comment
// that only tags people becomes "Tagged other members".
export function maskMentions(text: string, mentions: Mention[] | null | undefined): string {
  if (!mentions?.length) return text;
  let out = text;
  const byOffset = [...mentions].sort((a, b) => b.start - a.start);
  for (const m of byOffset) {
    if (out.slice(m.start, m.start + m.length) === m.text) {
      out = out.slice(0, m.start) + "[member]" + out.slice(m.start + m.length);
    }
  }
  for (const m of mentions) {
    const name = m.text.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${name}(?![\\p{L}\\p{N}])`, "gu"), "[member]");
  }
  return /^(?:[\s,.;:&+@\-–—]|and|\[member\])*$/i.test(out) ? "Tagged other members" : out;
}

// Public view: hide phone numbers and email addresses in comment text.
export function maskContacts(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email hidden]")
    .replace(/(?:\+?\d[\s().-]*){8,}\d/g, "[phone hidden]");
}
