import { BRANDS, ORM_ENABLED, postsToFetch, type Brand } from "@/lib/brands";
import { FETCHERS } from "@/lib/platforms";
import {
  fetchCompanyPosts,
  RETRY_DELAY_MS,
  mediaType,
  monthlyUsageUsd,
  parseFollowers,
  slugFromUrl,
  type ApifyPost,
} from "@/lib/apify";
import {
  retagComments,
  syncComments,
  type CommentSyncSummary,
} from "@/lib/comments";
import {
  imageSource,
  postsWithoutImage,
  saveThumbnails,
  type ThumbJob,
} from "@/lib/images";
import { supabaseAdmin } from "@/lib/supabase";
import { mergeExportPosts } from "@/lib/merge";
import { tagPosts } from "@/lib/themes";
import { retagX, syncX, type XSyncSummary } from "@/lib/xsync";
import {
  retagMentions,
  syncMentions,
  type MentionSyncSummary,
} from "@/lib/mentions";
import { runColumnsReady, type RunKind } from "@/lib/runs";
import { clip } from "@/lib/sanitise";
import {
  safeWrite,
  skippedNote,
  stepStats,
  type StepStats,
  type WriteResult,
} from "@/lib/safeWrite";

// Skip the whole run when this month's Apify usage is above this (the free plan gives $5).
// Read on every run, so a change to APIFY_MONTHLY_BUDGET_USD applies from the next sync.
const budgetUsd = () => Number(process.env.APIFY_MONTHLY_BUDGET_USD ?? 4.5);

// The evening mention search looks back this far, so late-appearing posts are not lost.
export const CATCH_UP_HOURS = 48;

export type PageResult = {
  brand: string;
  name: string;
  posts: number; // own posts saved (reposts and tagged posts by others are dropped)
  followers: number | null;
  ok: boolean; // the page answered (with posts of its own, or only other accounts' posts)
  otherOnly?: boolean; // answered, but its latest posts were all by other accounts
};

export type SyncSummary = {
  runId: number | null;
  status: "success" | "partial" | "failed" | "skipped";
  startedAt: string;
  finishedAt: string;
  postsSaved: number;
  imagesSaved: number;
  costUsd: number;
  pages: PageResult[]; // only the pages that were due this run
  failed: string[];
  notes: string;
  comments: CommentSyncSummary | null; // comment step, run after the posts
  x: XSyncSummary | null; // X step, run after the comments
  mentions: MentionSyncSummary | null; // LinkedIn mentions, run last
  steps: StepRecord; // per step: ok / partial / failed / skipped, rows saved and skipped
};

// sync_runs.step_stats: each step's outcome, for the dashboard's "Sync health (7 days)".
export type StepRecord = Partial<
  Record<"posts" | "comments" | "x" | "mentions", StepStats>
>;

// The run is "partial" when a step failed or skipped more than a fifth of its rows.
export function runStatus(steps: StepRecord): "success" | "partial" {
  return Object.values(steps).some(
    (s) => s && (s.status === "failed" || s.status === "partial"),
  )
    ? "partial"
    : "success";
}

// True once supabase/schema.sql adds sync_runs.step_stats.
async function stepStatsReady(
  db: ReturnType<typeof supabaseAdmin>,
): Promise<boolean> {
  return !(await db.from("sync_runs").select("step_stats").limit(1)).error;
}

type PostRow = {
  post_url: string;
  brand_id: string;
  linkedin_id: string;
  posted_at: string | null;
  text: string | null;
  media_type: string;
};
type SnapshotRow = {
  post_url: string;
  date: string;
  likes: number;
  comments: number;
  reposts: number;
};

// Snapshots are keyed by the IST calendar date, since the cron runs at 17:00 IST.
export function istDate(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    d,
  );
}

// A page is due when it has never synced, or when sync_every_days IST days have passed.
export function isDue(
  brand: Brand,
  lastSyncedAt: string | null | undefined,
  today = istDate(),
): boolean {
  if (!lastSyncedAt) return true;
  const days =
    (Date.parse(today) - Date.parse(istDate(new Date(lastSyncedAt)))) /
    86_400_000;
  return days >= brand.sync_every_days;
}

// Keep only posts by the page itself: authored by it, or collaboration posts it co-authored
// ("<Page> collaborated on this", which the actor reports under the person who started them). The
// actor also returns posts by people or other companies that the page reposted or was tagged in.
export function ownPosts(items: ApifyPost[], brand: Brand): ApifyPost[] {
  // Instagram, Facebook and X posts carry their page (lib/platforms.ts).
  if (brand.segment && brand.segment !== "linkedin")
    return items.filter((i) => i._page === brand.slug);
  return items.filter(
    (i) =>
      slugFromUrl(i.query?.targetUrl) === brand.slug &&
      (i.author?.universalName?.toLowerCase() === brand.slug ||
        (/collaborated/i.test(i.header?.text ?? "") &&
          slugFromUrl(i.header?.imageLink) === brand.slug)),
  );
}

// Items the actor returned for a page (whoever wrote them): 0 means the page did not answer.
const returnedFor = (items: ApifyPost[], brand: Brand) =>
  items.filter((i) =>
    i._page
      ? i._page === brand.slug
      : slugFromUrl(i.query?.targetUrl) === brand.slug,
  ).length;

// A LinkedIn page's slug in its URL; Resonia Pulse's page ids ("resonia-li") differ from it.
const liSlug = (b: Brand) => slugFromUrl(b.linkedin_url) ?? b.slug;
// ownPosts and returnedFor compare LinkedIn items with the slug in the page URL.
const asLinkedIn = (b: Brand): Brand => ({ ...b, slug: liSlug(b) });

// A one-off collection of everything posted since a day, on every platform (scripts/backfill.ts).
export type HistoryOptions = {
  label: string; // shown in Sync health, e.g. "Backfill 24 May - 24 Nov 2026"
  since: string; // YYYY-MM-DD (IST)
  maxPosts: Record<Brand["segment"], number>; // at most this many per page inside the window
  capUsd: Record<Brand["segment"], number>; // hard spending cap per platform
};

// LinkedIn: one Apify run per post count (e.g. 4 for competitors, 5 for Resonia), in parallel.
// Instagram, Facebook and X: one fetch per platform and post count (lib/platforms.ts).
// With `history`, every page's posts since history.since instead of its latest few.
type Collected = {
  bySlug: Map<string, ApifyPost[]>;
  returned: Map<string, number>;
  followers: Map<string, number>; // Instagram, Facebook and X (LinkedIn reads it from the posts)
  costUsd: number;
};

async function collect(
  brands: Brand[],
  today: string,
  history?: HistoryOptions,
): Promise<Collected> {
  const bySlug = new Map<string, ApifyPost[]>();
  const returned = new Map<string, number>();
  const followers = new Map<string, number>();
  const groups = new Map<
    string,
    { platform: Brand["segment"]; maxPosts: number; pages: Brand[] }
  >();
  for (const b of brands) {
    const n = history ? history.maxPosts[b.segment] : postsToFetch(b, today);
    const key = `${b.segment} ${n}`;
    const g = groups.get(key) ?? {
      platform: b.segment,
      maxPosts: n,
      pages: [],
    };
    g.pages.push(b);
    groups.set(key, g);
  }

  const costs = await Promise.all(
    [...groups.values()].map(async ({ platform, maxPosts, pages: group }) => {
      if (platform !== "linkedin") {
        const fetch = FETCHERS[platform];
        const r = await fetch(
          group,
          maxPosts,
          history?.since,
          history?.capUsd[platform],
        );
        for (const b of group) {
          bySlug.set(b.slug, ownPosts(r.items, b));
          returned.set(b.slug, r.returned.get(b.slug) ?? 0);
          const f = r.followers.get(b.slug);
          if (f != null) followers.set(b.slug, f);
        }
        return r.costUsd;
      }
      const li = group.map(asLinkedIn);
      const fetchLi = (pages: Brand[]) =>
        history
          ? fetchCompanyPosts(
              pages.map((b) => b.linkedin_url),
              maxPosts,
              RETRY_DELAY_MS,
              history.since,
              history.capUsd.linkedin,
            )
          : fetchCompanyPosts(
              pages.map((b) => b.linkedin_url),
              maxPosts,
            );
      const first = await fetchLi(li);
      for (const b of group) {
        bySlug.set(b.slug, ownPosts(first.items, asLinkedIn(b)));
        returned.set(b.slug, returnedFor(first.items, asLinkedIn(b)));
      }
      let cost = first.costUsd;

      // The actor occasionally returns nothing for a page in a batch run; retry those once. A page
      // that answered with only other accounts' posts is not retried (it would return the same).
      const empty = group.filter((b) => !returned.get(b.slug));
      if (empty.length) {
        const retry = await fetchLi(empty.map(asLinkedIn));
        for (const b of empty) {
          bySlug.set(b.slug, ownPosts(retry.items, asLinkedIn(b)));
          returned.set(b.slug, returnedFor(retry.items, asLinkedIn(b)));
        }
        cost += retry.costUsd;
      }
      return cost;
    }),
  );
  return {
    bySlug,
    returned,
    followers,
    costUsd: costs.reduce((a, b) => a + b, 0),
  };
}

// One LinkedIn post, one record. LinkedIn can change a post's link after it goes up, and posts are
// keyed by link, so the same post could be stored twice. Maps each fetched link whose LinkedIn id
// is already stored under another link (or already seen in this batch) to the link to keep.
export function aliasByLinkedinId(
  fetched: { post_url: string; linkedin_id: string }[],
  stored: { post_url: string; linkedin_id: string | null }[],
): Map<string, string> {
  const keep = new Map<string, string>();
  const storedUrls = new Set(stored.map((r) => r.post_url));
  // Stored links first (the earliest stored link per id), then the first link seen in the batch.
  for (const r of [...stored].sort((a, b) =>
    a.post_url.localeCompare(b.post_url),
  )) {
    if (r.linkedin_id && !keep.has(r.linkedin_id))
      keep.set(r.linkedin_id, r.post_url);
  }
  const alias = new Map<string, string>();
  for (const f of fetched) {
    if (!f.linkedin_id || storedUrls.has(f.post_url)) continue; // already stored under this link
    const to = keep.get(f.linkedin_id);
    if (!to) keep.set(f.linkedin_id, f.post_url);
    else if (to !== f.post_url) alias.set(f.post_url, to);
  }
  return alias;
}

// force: fetch every page even if it already synced today (to redo a failed day by hand).
// history: a one-off collection of every page's posts since a day (see HistoryOptions).
export async function runSync({
  dryRun = false,
  brands = BRANDS,
  force = false,
  history,
}: {
  dryRun?: boolean;
  brands?: Brand[];
  force?: boolean;
  history?: HistoryOptions;
} = {}): Promise<SyncSummary> {
  const startedAt = new Date().toISOString();
  // How long each step took, saved in the notes so a run near the function time limit shows up.
  const timings: string[] = [];
  let mark = Date.now();
  const lap = (step: string) => {
    timings.push(`${step} ${Math.round((Date.now() - mark) / 1000)}s`);
    mark = Date.now();
  };
  const today = istDate();
  const db = dryRun ? null : supabaseAdmin();
  let runId: number | null = null;
  const lastSynced = new Map<string, string | null>();
  // False until supabase/schema.sql has been re-run with the schedule and budget columns.
  let migrated = true;
  // False until schema.sql has been re-run with posts.image_path and posts.theme_manual.
  let postColumns = true;
  // False until schema.sql adds sync_runs.kind and the per-step status columns.
  let runCols = false;
  // False until schema.sql adds posts.origin (posts from LinkedIn exports and the backfill).
  let originCol = false;
  // False until schema.sql adds sync_runs.step_stats.
  let statsCol = false;

  if (db) {
    // last_synced_at is left out so the stored value is kept.
    const { error: brandErr } = await db.from("brands").upsert(
      brands.map((b) => ({
        id: b.slug,
        name: b.name,
        linkedin_url: b.linkedin_url,
        segment: b.segment,
        is_montra: b.is_montra,
      })),
      { onConflict: "id" },
    );
    if (brandErr) throw new Error(`brands upsert: ${brandErr.message}`);
    const { data: rows, error: lastErr } = await db
      .from("brands")
      .select("id,last_synced_at");
    migrated = !lastErr;
    for (const r of rows ?? []) lastSynced.set(r.id, r.last_synced_at);
    postColumns = !(
      await db.from("posts").select("image_path,theme_manual").limit(1)
    ).error;
    originCol = !(await db.from("posts").select("origin").limit(1)).error;
    runCols = await runColumnsReady(db);
    statsCol = await stepStatsReady(db);
    const { data, error } = await db
      .from("sync_runs")
      .insert({
        started_at: startedAt,
        ...(runCols ? { kind: history ? "backfill" : "evening" } : {}),
      })
      .select("id")
      .single();
    if (error) throw new Error(`sync_runs insert: ${error.message}`);
    runId = data.id;
  }

  const finish = async (fields: Record<string, unknown>) => {
    if (!db || runId == null) return;
    const { error } = await db.from("sync_runs").update(fields).eq("id", runId);
    if (error) throw new Error(`sync_runs update: ${error.message}`);
  };
  const schemaNote =
    migrated && postColumns
      ? ""
      : "Database schema is out of date: re-run supabase/schema.sql";

  const BUDGET_USD = budgetUsd();
  try {
    const usage = await monthlyUsageUsd();
    if (usage > BUDGET_USD) {
      const notes = [
        `Skipped: Apify usage this month is $${usage.toFixed(2)}, above the $${BUDGET_USD.toFixed(2)} limit`,
        schemaNote,
      ]
        .filter(Boolean)
        .join(". ");
      const finishedAt = new Date().toISOString();
      await finish({
        finished_at: finishedAt,
        status: migrated ? "skipped" : "failed",
        posts_saved: 0,
        notes,
      });
      return {
        runId,
        status: "skipped",
        startedAt,
        finishedAt,
        postsSaved: 0,
        imagesSaved: 0,
        costUsd: 0,
        pages: [],
        failed: [],
        notes,
        comments: null,
        x: null,
        mentions: null,
        steps: {},
      };
    }

    const due =
      force || history
        ? brands
        : brands.filter((b) => isDue(b, lastSynced.get(b.slug), today));
    // A failed posts step (after its retry) never blocks comments, X and mentions.
    let postsError = "";
    let collected: Collected = {
      bySlug: new Map(),
      returned: new Map(),
      followers: new Map(),
      costUsd: 0,
    };
    if (due.length) {
      try {
        collected = await collect(due, today, history);
      } catch (err) {
        postsError = `Posts step failed after a retry (${clip(String(err), 200)}); posts catch up next run`;
      }
    }
    const {
      bySlug,
      returned,
      costUsd,
      followers: platformFollowers,
    } = collected;
    lap("posts");
    const posts = new Map<string, PostRow>();
    const snapshots = new Map<string, SnapshotRow>();
    const followers: { brand_id: string; date: string; followers: number }[] =
      [];
    const pages: PageResult[] = [];
    const imageSrc = new Map<string, string>();

    for (const b of due) {
      const items: ApifyPost[] = bySlug.get(b.slug) ?? [];
      for (const p of items) {
        posts.set(p.linkedinUrl, {
          post_url: p.linkedinUrl,
          brand_id: b.slug,
          linkedin_id: p.id,
          posted_at: p.postedAt?.date ?? null,
          text: p.content ?? null,
          media_type: mediaType(p),
        });
        const src = imageSource(p);
        if (src) imageSrc.set(p.linkedinUrl, src);
        snapshots.set(p.linkedinUrl, {
          post_url: p.linkedinUrl,
          date: today,
          likes: p.engagement?.likes ?? 0,
          comments: p.engagement?.comments ?? 0,
          reposts: p.engagement?.shares ?? 0,
        });
      }
      // Followers come from the page's own author line (a collaboration post's author is a person).
      const authorSlug =
        b.segment === "linkedin"
          ? (slugFromUrl(b.linkedin_url) ?? b.slug)
          : b.slug;
      const count =
        platformFollowers.get(b.slug) ??
        items
          .filter((p) => p.author?.universalName?.toLowerCase() === authorSlug)
          .map((p) => parseFollowers(p.author.info))
          .find((n) => n != null) ??
        null;
      if (count != null)
        followers.push({ brand_id: b.slug, date: today, followers: count });
      // A page that answered with only other accounts' posts (people it reposted or was tagged by)
      // has nothing new of its own: not a failure.
      const answered = items.length > 0 || (returned.get(b.slug) ?? 0) > 0;
      pages.push({
        brand: b.slug,
        name: b.name,
        posts: items.length,
        followers: count,
        ok: answered,
        otherOnly: !items.length && answered,
      });
    }
    const synced = pages.filter((p) => p.ok).map((p) => p.brand);
    let images = {
      saved: 0,
      failed: [] as { post_url: string; error: string }[],
    };

    // De-duplicate by LinkedIn post id: a post already stored under another link keeps that record.
    let relinked = 0;
    if (db && posts.size) {
      const ids = [
        ...new Set(
          [...posts.values()].map((r) => r.linkedin_id).filter(Boolean),
        ),
      ];
      const stored: { post_url: string; linkedin_id: string | null }[] = [];
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await db
          .from("posts")
          .select("post_url,linkedin_id")
          .in("linkedin_id", ids.slice(i, i + 100));
        if (error) throw new Error(`posts select: ${error.message}`);
        stored.push(
          ...(data as { post_url: string; linkedin_id: string | null }[]),
        );
      }
      for (const [from, to] of aliasByLinkedinId([...posts.values()], stored)) {
        const row = posts.get(from)!;
        const snap = snapshots.get(from)!;
        posts.delete(from);
        snapshots.delete(from);
        if (!posts.has(to)) {
          posts.set(to, { ...row, post_url: to });
          snapshots.set(to, { ...snap, post_url: to });
          const src = imageSrc.get(from);
          if (src) imageSrc.set(to, src);
        }
        imageSrc.delete(from);
        relinked++;
      }
    }
    let postWrites: WriteResult[] = [];
    let postsSaved = posts.size; // on a dry run, what would be saved

    if (db && synced.length) {
      // theme and first_seen_at are left out so existing values are kept on update. A post the
      // daily sync reads is a normal tracked post from now on (origin "sync"). A row the database
      // refuses is skipped and logged (lib/safeWrite.ts); the rest are saved.
      const write = { runId, step: "posts", mode: "upsert" as const };
      const rows = [...posts.values()].map((r) =>
        originCol ? { ...r, origin: history ? "backfill" : "sync" } : r,
      );
      const postWrite = await safeWrite(db, {
        ...write,
        table: "posts",
        rows,
        key: (r) => r.post_url,
        onConflict: "post_url",
      });
      const ok = new Set(postWrite.savedIds);
      postsSaved = postWrite.saved;
      // Posts created from an uploaded LinkedIn export are folded into the same post found here.
      if (originCol)
        await mergeExportPosts(
          db,
          [...posts.values()].filter((p) => ok.has(p.post_url)),
        );
      postWrites = [
        postWrite,
        await safeWrite(db, {
          ...write,
          table: "post_snapshots",
          rows: [...snapshots.values()].filter((r) => ok.has(r.post_url)),
          key: (r) => `${r.post_url} ${r.date}`,
          onConflict: "post_url,date",
        }),
        await safeWrite(db, {
          ...write,
          table: "follower_snapshots",
          rows: followers,
          key: (r) => `${r.brand_id} ${r.date}`,
          onConflict: "brand_id,date",
        }),
      ];
      await tagPosts(db);
      // Thumbnails for posts seen for the first time (or whose earlier download failed),
      // while LinkedIn's image URLs from this fetch are still fresh.
      if (postColumns) {
        const missing = await postsWithoutImage(db, [...imageSrc.keys()]);
        const jobs: ThumbJob[] = [...missing].map((url) => {
          const row = posts.get(url)!;
          return {
            post_url: url,
            brand_id: row.brand_id,
            linkedin_id: row.linkedin_id,
            src: imageSrc.get(url)!,
          };
        });
        images = await saveThumbnails(db, jobs);
        lap("images");
      }
      if (migrated) {
        const { error: e4 } = await db
          .from("brands")
          .update({ last_synced_at: startedAt })
          .in("id", synced);
        if (e4) throw new Error(`brands last_synced_at update: ${e4.message}`);
      }
    }

    // Comments run after the posts and share the budget; a failure here never fails the posts sync.
    let comments: CommentSyncSummary | null = null;
    let commentsError = "";
    if (db && ORM_ENABLED) {
      try {
        comments = await syncComments(db, {
          budgetUsd: BUDGET_USD,
          syncRunId: runId,
        });
      } catch (err) {
        commentsError = `Comments failed: ${clip(String(err), 300)}`;
      }
      lap("comments");
    }

    // X runs last and only spends what posts and comments leave; a failure here never fails the run.
    let x: XSyncSummary | null = null;
    let xError = "";
    if (db && ORM_ENABLED) {
      try {
        x = await syncX(db, { budgetUsd: BUDGET_USD, syncRunId: runId });
      } catch (err) {
        xError = `X failed: ${clip(String(err), 300)}`;
      }
      lap("X");
    }

    // LinkedIn mentions come last in the budget order: posts, comments and X are set aside first.
    let mentions: MentionSyncSummary | null = null;
    let mentionsError = "";
    if (db && ORM_ENABLED) {
      try {
        // Evening catch-up: the last 48 hours, for posts LinkedIn's search showed late.
        mentions = await syncMentions(db, {
          budgetUsd: BUDGET_USD,
          hours: CATCH_UP_HOURS,
          catchUp: true,
          syncRunId: runId,
        });
      } catch (err) {
        mentionsError = `LinkedIn mentions failed: ${clip(String(err), 300)}`;
      }
      lap("mentions");
    }

    // Re-apply themes.json and sentiment.json to everything stored, so edits to either file take
    // effect without running npm commands. Only rows whose tag changes are written; themes set
    // by hand on the dashboard and "handled" marks are kept. A failure here never fails the run.
    let retagNote = "";
    if (db) {
      try {
        const [posts, cmts, tweets, liMentions] = [
          postColumns ? await tagPosts(db, { all: true }) : 0,
          ORM_ENABLED ? await retagComments(db) : 0,
          ORM_ENABLED ? await retagX(db) : 0,
          ORM_ENABLED ? await retagMentions(db) : 0,
        ];
        if (posts || cmts || tweets || liMentions) {
          retagNote = `Re-tagged after a keyword change: ${posts} posts, ${cmts} comments, ${tweets} X mentions, ${liMentions} LinkedIn mentions`;
        }
      } catch (err) {
        retagNote = `Re-tagging failed: ${clip(String(err), 200)}`;
      }
      lap("re-tag");
    }

    const failed = pages.filter((p) => !p.ok).map((p) => p.brand);
    const noFollowers = pages
      .filter((p) => p.ok && p.followers == null)
      .map((p) => p.brand);
    const otherOnly = pages.filter((p) => p.otherOnly).map((p) => p.brand);
    // Every step counts: one that throws, or skips more than a fifth of its rows, makes the run
    // partial. All due pages returning nothing is a failed run.
    const steps: StepRecord = {
      posts: (() => {
        const s = stepStats(postWrites, {
          error: postsError || undefined,
          skipped: !due.length,
        });
        return failed.length && s.status === "ok"
          ? {
              ...s,
              status: "partial",
              error: `No posts returned for: ${failed.join(", ")}`,
            }
          : s;
      })(),
      ...(db && ORM_ENABLED
        ? {
            comments: stepStats(comments?.writes ?? [], {
              error: commentsError || undefined,
              skipped: comments?.status === "skipped",
            }),
            x: stepStats(x?.writes ?? [], {
              error: xError || undefined,
              skipped: x?.status === "skipped",
            }),
            mentions: stepStats(mentions?.writes ?? [], {
              error: mentionsError || undefined,
              skipped: mentions?.status === "skipped",
            }),
          }
        : {}),
    };
    const status =
      pages.length && failed.length === pages.length
        ? "failed"
        : runStatus(steps);
    const notes = [
      history ? history.label : "",
      due.length ? "" : "No pages due today",
      relinked
        ? `${relinked} posts matched to an existing record by LinkedIn id`
        : "",
      postsError,
      failed.length ? `No posts returned for: ${failed.join(", ")}` : "",
      otherOnly.length
        ? `Latest posts were all by other accounts (nothing new of its own) for: ${otherOnly.join(", ")}`
        : "",
      noFollowers.length
        ? `No follower count for: ${noFollowers.join(", ")}`
        : "",
      images.failed.length
        ? `Images not saved for ${images.failed.length} posts (${images.failed[0].error})`
        : "",
      skippedNote("Posts", postWrites),
      migrated ? "" : `Apify cost $${costUsd.toFixed(4)}`,
      comments && comments.status !== "success" ? comments.notes : "",
      comments?.status === "success"
        ? `Comments saved: ${comments.commentsSaved}${comments.notes ? ` (${comments.notes})` : ""}`
        : "",
      commentsError,
      skippedNote("Comments", comments?.writes ?? []),
      x && x.status !== "success" ? x.notes : "",
      x?.status === "success"
        ? `X: ${x.saved.mentions} new mentions, ${x.saved.replies} replies${x.notes ? ` (${x.notes})` : ""}`
        : "",
      xError,
      skippedNote("X", x?.writes ?? []),
      mentions && mentions.status !== "success" ? mentions.notes : "",
      mentions?.status === "success"
        ? `LinkedIn mentions: ${mentions.saved} new${mentions.notes ? ` (${mentions.notes})` : ""}`
        : "",
      mentionsError,
      skippedNote("LinkedIn mentions", mentions?.writes ?? []),
      retagNote,
      schemaNote,
      timings.length ? `Took ${timings.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(". ");
    const finishedAt = new Date().toISOString();
    await finish({
      finished_at: finishedAt,
      status,
      pages_succeeded: synced.length,
      pages_failed: failed,
      posts_saved: postsSaved,
      ...(statsCol ? { step_stats: steps } : {}),
      notes: notes || null,
      ...(migrated
        ? {
            pages_attempted: due.map((b) => b.slug),
            apify_cost_usd:
              costUsd +
              (comments?.costUsd ?? 0) +
              (x?.costUsd ?? 0) +
              (mentions?.costUsd ?? 0),
          }
        : {}),
      ...((comments && comments.status !== "skipped") || commentsError
        ? {
            comments_saved: comments?.commentsSaved ?? 0,
            comments_cost_usd: comments?.costUsd ?? 0,
          }
        : {}),
      ...((x && x.status !== "skipped") || xError
        ? {
            x_saved: (x?.saved.mentions ?? 0) + (x?.saved.replies ?? 0),
            x_cost_usd: x?.costUsd ?? 0,
          }
        : {}),
      ...((mentions && mentions.status !== "skipped") || mentionsError
        ? {
            mentions_saved: mentions?.saved ?? 0,
            mentions_cost_usd: mentions?.costUsd ?? 0,
          }
        : {}),
      ...(runCols ? stepFields(x, xError, mentions, mentionsError) : {}),
    });
    return {
      runId,
      status,
      startedAt,
      finishedAt,
      postsSaved,
      imagesSaved: images.saved,
      costUsd,
      pages,
      failed,
      notes,
      comments,
      x,
      mentions,
      steps,
    };
  } catch (err) {
    await finish({
      finished_at: new Date().toISOString(),
      status: "failed",
      notes: [clip(String(err), 1000), schemaNote].filter(Boolean).join(". "),
    }).catch(() => {});
    throw err;
  }
}

// Per-step outcome, so the next run's X and mention searches start where the last successful one did.
function stepFields(
  x: XSyncSummary | null,
  xError: string,
  mentions: MentionSyncSummary | null,
  mentionsError: string,
): Record<string, unknown> {
  return {
    x_status: xError ? "failed" : (x?.status ?? null),
    mentions_status: mentionsError ? "failed" : (mentions?.status ?? null),
    mentions_fetched: mentions?.fetched ?? 0,
  };
}

export type ScanSummary = {
  runId: number | null;
  kind: RunKind;
  status: "success" | "partial" | "failed" | "skipped";
  costUsd: number;
  x: XSyncSummary | null;
  mentions: MentionSyncSummary | null;
  notes: string;
  steps: StepRecord;
};

// Morning (07:00 IST) and afternoon (13:00 IST) ORM scans: only the X step (without our posts and
// the follower count) and the LinkedIn mention search. Posts and comments stay in the evening run,
// which keeps first call on the budget: both steps set aside today's evening post sync too.
// onApifyStarted fires once the scan's Apify calls are under way (the 7am route starts the Radar
// fetch then, so the scan is never delayed by it).
export async function runScan(
  kind: Exclude<RunKind, "evening">,
  { onApifyStarted }: { onApifyStarted?: () => void } = {},
): Promise<ScanSummary> {
  const db = supabaseAdmin();
  const BUDGET_USD = budgetUsd();
  const startedAt = new Date().toISOString();
  const runCols = await runColumnsReady(db);
  const { data, error } = await db
    .from("sync_runs")
    .insert({ started_at: startedAt, ...(runCols ? { kind } : {}) })
    .select("id")
    .single();
  if (error) throw new Error(`sync_runs insert: ${error.message}`);
  const runId = data.id as number;
  const finish = async (fields: Record<string, unknown>) => {
    const { error: e } = await db
      .from("sync_runs")
      .update(fields)
      .eq("id", runId);
    if (e) throw new Error(`sync_runs update: ${e.message}`);
  };
  const label = kind === "morning" ? "Morning scan" : "Afternoon scan";
  if (!runCols) {
    const notes = `${label} skipped: re-run supabase/schema.sql to add sync_runs.kind`;
    await finish({
      finished_at: new Date().toISOString(),
      status: "skipped",
      notes,
    });
    return {
      runId,
      kind,
      status: "skipped",
      costUsd: 0,
      x: null,
      mentions: null,
      notes,
      steps: {},
    };
  }
  const statsCol = await stepStatsReady(db);
  try {
    const usage = await monthlyUsageUsd();
    if (usage > BUDGET_USD) {
      const notes = `Skipped: Apify usage this month is $${usage.toFixed(2)}, above the $${BUDGET_USD.toFixed(2)} limit`;
      await finish({
        finished_at: new Date().toISOString(),
        status: "skipped",
        notes,
      });
      return {
        runId,
        kind,
        status: "skipped",
        costUsd: 0,
        x: null,
        mentions: null,
        notes,
        steps: {},
      };
    }
    let x: XSyncSummary | null = null;
    let xError = "";
    try {
      const xRun = syncX(db, {
        budgetUsd: BUDGET_USD,
        includePosts: false,
        includeTodaysPosts: true,
        syncRunId: runId,
      });
      onApifyStarted?.();
      x = await xRun;
    } catch (err) {
      xError = `X failed: ${clip(String(err), 300)}`;
    }
    let mentions: MentionSyncSummary | null = null;
    let mentionsError = "";
    try {
      mentions = await syncMentions(db, {
        budgetUsd: BUDGET_USD,
        includeTodaysPosts: true,
        syncRunId: runId,
      });
    } catch (err) {
      mentionsError = `LinkedIn mentions failed: ${clip(String(err), 300)}`;
    }
    const costUsd = (x?.costUsd ?? 0) + (mentions?.costUsd ?? 0);
    const steps: StepRecord = {
      x: stepStats(x?.writes ?? [], {
        error: xError || undefined,
        skipped: x?.status === "skipped",
      }),
      mentions: stepStats(mentions?.writes ?? [], {
        error: mentionsError || undefined,
        skipped: mentions?.status === "skipped",
      }),
    };
    const status = xError && mentionsError ? "failed" : runStatus(steps);
    const notes = [
      label,
      x && x.status !== "success" ? x.notes : "",
      x?.status === "success"
        ? `X: ${x.saved.mentions} new mentions, ${x.saved.replies} replies`
        : "",
      xError,
      skippedNote("X", x?.writes ?? []),
      mentions && mentions.status !== "success" ? mentions.notes : "",
      mentions?.status === "success"
        ? `LinkedIn mentions: ${mentions.saved} new`
        : "",
      mentionsError,
      skippedNote("LinkedIn mentions", mentions?.writes ?? []),
    ]
      .filter(Boolean)
      .join(". ");
    await finish({
      finished_at: new Date().toISOString(),
      status,
      posts_saved: 0,
      notes,
      apify_cost_usd: costUsd,
      x_saved: (x?.saved.mentions ?? 0) + (x?.saved.replies ?? 0),
      x_cost_usd: x?.costUsd ?? 0,
      mentions_saved: mentions?.saved ?? 0,
      mentions_cost_usd: mentions?.costUsd ?? 0,
      ...stepFields(x, xError, mentions, mentionsError),
      ...(statsCol ? { step_stats: steps } : {}),
    });
    return { runId, kind, status, costUsd, x, mentions, notes, steps };
  } catch (err) {
    await finish({
      finished_at: new Date().toISOString(),
      status: "failed",
      notes: `${label}: ${clip(String(err), 1000)}`,
    }).catch(() => {});
    throw err;
  }
}
