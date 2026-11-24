// Instagram, Facebook and X posts for Resonia Pulse. Each platform has its own Apify actor; its items
// are normalised into the LinkedIn post shape (ApifyPost) so the rest of the sync, the thumbnails, the
// theme tagging and the dashboard work unchanged. LinkedIn itself stays in lib/apify.ts.
//
// Actors (no login, no cookies):
//   Instagram posts      apify/instagram-post-scraper     pay per result
//   Instagram followers  apify/instagram-profile-scraper  pay per result
//   Facebook posts       apify/facebook-posts-scraper     pay per result
//   Facebook followers   apify/facebook-pages-scraper     pay per result
//   X posts + followers  scrape.badger/twitter-tweets-scraper (as in Resonia Pulse's X step)
// Prices below are set on the high side so the spending caps never cut a run short; every run's real
// cost is read back from Apify (usageTotalUsd) and logged in sync_runs.apify_cost_usd.
import { BACKFILL_TIMEOUT_SECS, runActor, type ApifyPost } from "@/lib/apify";
import type { Brand } from "@/lib/brands";
import { parseXDate, tweetText, type BadgerTweet } from "@/lib/x";

export const ACTORS = {
  igPosts: "apify~instagram-post-scraper",
  igProfile: "apify~instagram-profile-scraper",
  fbPosts: "apify~facebook-posts-scraper",
  fbPage: "apify~facebook-pages-scraper",
  x: "scrape.badger~twitter-tweets-scraper",
} as const;

export const PRICE_USD = {
  igPost: 0.0027,
  igProfile: 0.003,
  fbPost: 0.006,
  fbPage: 0.01,
  tweet: 0.0002,
} as const;

export type PlatformResult = {
  items: ApifyPost[];
  followers: Map<string, number>;
  returned: Map<string, number>;
  costUsd: number;
};

// ---------- Instagram ----------

export type IgPost = {
  id?: string;
  type?: string; // Image / Video / Sidecar
  shortCode?: string;
  caption?: string | null;
  url?: string | null;
  commentsCount?: number | null;
  likesCount?: number | null; // -1 when the owner hides likes
  videoViewCount?: number | null;
  timestamp?: string | null;
  displayUrl?: string | null;
  images?: string[] | null;
  childPosts?: { displayUrl?: string | null }[] | null;
  ownerUsername?: string | null;
  isPinned?: boolean | null;
  error?: string;
};

export type IgProfile = {
  username?: string | null;
  followersCount?: number | null;
};

export function igToPost(p: IgPost, page: Brand): ApifyPost | null {
  if (!p.shortCode && !p.url) return null;
  const url = p.shortCode
    ? `https://www.instagram.com/p/${p.shortCode}/`
    : p.url!;
  const slides = (
    p.images?.length
      ? p.images
      : (p.childPosts ?? []).map((c) => c.displayUrl ?? "")
  ).filter(Boolean);
  const isVideo = /video/i.test(p.type ?? "");
  const isCarousel = /sidecar/i.test(p.type ?? "") && slides.length > 1;
  return {
    type: "post",
    id: `ig-${p.id ?? p.shortCode ?? url}`, // prefixed so ids never clash across platforms
    linkedinUrl: url,
    content: p.caption ?? null,
    author: { universalName: page.slug, name: page.name },
    postedAt: p.timestamp
      ? { date: new Date(p.timestamp).toISOString() }
      : null,
    postImages: isVideo
      ? null
      : (isCarousel ? slides : [p.displayUrl ?? slides[0] ?? ""])
          .filter(Boolean)
          .map((u) => ({ url: u })),
    postVideo: isVideo ? { thumbnailUrl: p.displayUrl ?? null } : null,
    engagement: {
      likes: Math.max(0, p.likesCount ?? 0),
      comments: Math.max(0, p.commentsCount ?? 0),
      shares: 0,
    },
    _page: page.slug,
  };
}

export async function fetchInstagram(
  pages: Brand[],
  maxPosts: number,
  since?: string,
  capUsd?: number,
): Promise<PlatformResult> {
  const handles = pages.map((p) => p.handle!).filter(Boolean);
  const byHandle = new Map(pages.map((p) => [p.handle!.toLowerCase(), p]));
  const limit = handles.length * maxPosts;
  const run = await runActor<IgPost>(
    ACTORS.igPosts,
    {
      username: handles,
      resultsLimit: maxPosts,
      ...(since ? { onlyPostsNewerThan: since } : {}),
    },
    capUsd ?? limit * PRICE_USD.igPost * 1.5 + 0.01,
    limit + handles.length * 3, // pinned posts can come back outside the date window
    since ? BACKFILL_TIMEOUT_SECS : undefined,
  );
  const items: ApifyPost[] = [];
  const returned = new Map<string, number>();
  for (const p of run.items) {
    const page = byHandle.get((p.ownerUsername ?? "").toLowerCase());
    if (!page) continue;
    returned.set(page.slug, (returned.get(page.slug) ?? 0) + 1);
    if (since && p.timestamp && p.timestamp.slice(0, 10) < since) continue; // an old pinned post
    const post = igToPost(p, page);
    if (post) items.push(post);
  }
  const prof = await runActor<IgProfile>(
    ACTORS.igProfile,
    { usernames: handles },
    handles.length * PRICE_USD.igProfile * 1.5 + 0.01,
    handles.length,
  );
  const followers = new Map<string, number>();
  for (const pr of prof.items) {
    const page = byHandle.get((pr.username ?? "").toLowerCase());
    if (page && pr.followersCount != null)
      followers.set(page.slug, pr.followersCount);
  }
  return {
    items,
    followers,
    returned,
    costUsd:
      Math.max(run.usageUsd, run.items.length * PRICE_USD.igPost * 0.8) +
      prof.usageUsd,
  };
}

// ---------- Facebook ----------

export type FbPost = {
  postId?: string;
  url?: string | null;
  topLevelUrl?: string | null;
  text?: string | null;
  time?: string | null;
  timestamp?: number | null;
  likes?: number | null;
  comments?: number | null;
  shares?: number | null;
  isVideo?: boolean | null;
  media?:
    | {
        thumbnail?: string | null;
        photo_image?: { uri?: string } | null;
        __typename?: string;
      }[]
    | null;
  facebookUrl?: string | null; // the page URL given as input
  inputUrl?: string | null;
  error?: string;
};

export type FbPage = {
  facebookUrl?: string | null;
  pageUrl?: string | null;
  followers?: number | null;
  likes?: number | null;
};

export function fbToPost(p: FbPost, page: Brand): ApifyPost | null {
  const url = p.url ?? p.topLevelUrl;
  if (!url) return null;
  const pics = (p.media ?? [])
    .map((m) => m.thumbnail ?? m.photo_image?.uri ?? "")
    .filter(Boolean);
  const isVideo =
    !!p.isVideo ||
    (p.media ?? []).some((m) => /video/i.test(m.__typename ?? ""));
  const posted = p.time
    ? new Date(p.time)
    : p.timestamp
      ? new Date(p.timestamp * 1000)
      : null;
  return {
    type: "post",
    id: `fb-${p.postId ?? url}`,
    linkedinUrl: url,
    content: p.text ?? null,
    author: { universalName: page.slug, name: page.name },
    postedAt:
      posted && !Number.isNaN(posted.getTime())
        ? { date: posted.toISOString() }
        : null,
    postImages: isVideo ? null : pics.map((u) => ({ url: u })),
    postVideo: isVideo ? { thumbnailUrl: pics[0] ?? null } : null,
    engagement: {
      likes: p.likes ?? 0,
      comments: p.comments ?? 0,
      shares: p.shares ?? 0,
    },
    _page: page.slug,
  };
}

// One run per page, so every post is attributed to the page it was fetched for.
export async function fetchFacebook(
  pages: Brand[],
  maxPosts: number,
  since?: string,
  capUsd?: number,
): Promise<PlatformResult> {
  const items: ApifyPost[] = [];
  const returned = new Map<string, number>();
  const followers = new Map<string, number>();
  let costUsd = 0;
  for (const page of pages) {
    const run = await runActor<FbPost>(
      ACTORS.fbPosts,
      {
        startUrls: [{ url: page.linkedin_url }],
        resultsLimit: maxPosts,
        captionText: false,
        ...(since ? { onlyPostsNewerThan: since } : {}),
      },
      capUsd ? capUsd / pages.length : maxPosts * PRICE_USD.fbPost * 1.5 + 0.01,
      maxPosts,
      since ? BACKFILL_TIMEOUT_SECS : undefined,
    );
    const own = run.items.filter((p) => !p.error);
    returned.set(page.slug, own.length);
    for (const p of own) {
      const post = fbToPost(p, page);
      if (post) items.push(post);
    }
    costUsd += Math.max(run.usageUsd, own.length * PRICE_USD.fbPost * 0.8);
    const info = await runActor<FbPage>(
      ACTORS.fbPage,
      { startUrls: [{ url: page.linkedin_url }] },
      PRICE_USD.fbPage * 1.5 + 0.01,
      1,
    );
    const n = info.items[0]?.followers ?? info.items[0]?.likes ?? null;
    if (n != null) followers.set(page.slug, n);
    costUsd += info.usageUsd;
  }
  return { items, followers, returned, costUsd };
}

// ---------- X ----------

export function hasVideo(t: BadgerTweet): boolean {
  return (t.media ?? []).some((m) => /video|gif/i.test(JSON.stringify(m)));
}

export function mediaUrl(t: BadgerTweet): string | null {
  for (const m of t.media ?? []) {
    const o = m as Record<string, unknown>;
    const u =
      o.media_url_https ?? o.thumbnail_url ?? o.preview_image_url ?? o.url;
    if (typeof u === "string" && /^https:/.test(u)) return u;
  }
  return null;
}

export function tweetToPost(t: BadgerTweet, page: Brand): ApifyPost | null {
  if (!t.id || t.is_retweet) return null;
  const pic = mediaUrl(t);
  const video = hasVideo(t);
  return {
    type: "post",
    id: `x-${t.id}`,
    linkedinUrl: `https://x.com/${page.handle}/status/${t.id}`,
    content: tweetText(t),
    author: { universalName: page.slug, name: page.name },
    postedAt: parseXDate(t.created_at)
      ? { date: parseXDate(t.created_at)! }
      : null,
    postImages: !video && pic ? [{ url: pic }] : null,
    postVideo: video ? { thumbnailUrl: pic } : null,
    // Likes, replies and reposts; views are not stored (no other platform has them for every post).
    engagement: {
      likes: t.favorite_count ?? 0,
      comments: t.reply_count ?? 0,
      shares: (t.retweet_count ?? 0) + (t.quote_count ?? 0),
    },
    _page: page.slug,
  };
}

// The page's own posts (no replies, no reposts), newest first. With `since`, everything from that day on.
export async function fetchX(
  pages: Brand[],
  maxPosts: number,
  since?: string,
  capUsd?: number,
): Promise<PlatformResult> {
  const items: ApifyPost[] = [];
  const returned = new Map<string, number>();
  const followers = new Map<string, number>();
  let costUsd = 0;
  for (const page of pages) {
    const query = `from:${page.handle} -filter:replies -filter:retweets${since ? ` since:${since}` : ""}`;
    const run = await runActor<BadgerTweet>(
      ACTORS.x,
      {
        mode: "Advanced Search",
        query,
        query_type: "Latest",
        max_results: maxPosts,
      },
      capUsd ? capUsd / pages.length : maxPosts * PRICE_USD.tweet * 1.5 + 0.01,
      undefined,
      since ? BACKFILL_TIMEOUT_SECS : undefined,
    );
    const own = run.items.filter(
      (t) => (t.username ?? "").toLowerCase() === page.handle!.toLowerCase(),
    );
    returned.set(page.slug, run.items.length);
    for (const t of own) {
      const post = tweetToPost(t, page);
      if (post) items.push(post);
    }
    const f = own.find(
      (t) => t.user_followers_count != null,
    )?.user_followers_count;
    if (f != null) followers.set(page.slug, f);
    costUsd += Math.max(run.usageUsd, run.items.length * PRICE_USD.tweet);
  }
  return { items, followers, returned, costUsd };
}

export const FETCHERS = {
  instagram: fetchInstagram,
  facebook: fetchFacebook,
  x: fetchX,
} as const;
