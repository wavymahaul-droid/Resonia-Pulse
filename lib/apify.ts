// LinkedIn: company posts with harvestapi/linkedin-company-posts (no cookies, no login).
// Instagram, Facebook and X use other actors (lib/platforms.ts) and are normalised into ApifyPost.
// Each post item carries the author's follower count in author.info
// ("620,189 followers"), so no separate company-profile actor is needed.

const ACTOR = "harvestapi~linkedin-company-posts";
const API = "https://api.apify.com/v2";

export type ApifyPost = {
  type: string;
  id: string;
  linkedinUrl: string;
  content?: string | null;
  author: { universalName?: string | null; name?: string; info?: string | null; type?: string };
  postedAt?: { timestamp?: number; date?: string } | null;
  postImages?: { url?: string; width?: number; height?: number }[] | null;
  postVideo?: { thumbnailUrl?: string | null; videoUrl?: string | null } | null;
  document?: { title?: string; coverPages?: { imageUrls?: string[] }[] | null } | null;
  article?: { title?: string; image?: { url?: string } | null } | null;
  engagement?: { likes?: number; comments?: number; shares?: number } | null;
  query?: { targetUrl?: string } | null;
  // Set on collaboration posts: "<Page> collaborated on this", with a link to the page.
  header?: { text?: string | null; imageLink?: string | null } | null;
  // Set by lib/platforms.ts on Instagram, Facebook and X posts (normalised into this shape): the
  // brands.json slug of the page the post belongs to. LinkedIn posts leave it unset.
  _page?: string;
};

// Pay-per-event price of one post on the free plan (see the actor's pricing tab).
export const PRICE_PER_POST_USD = 0.002;

export type ApifyResult = { items: ApifyPost[]; costUsd: number };

// The token from APIFY_TOKEN, with stray spaces, quotes or a "Bearer " prefix removed. A value
// that is blank after that fails here with a clear message rather than as Apify's
// "401 token-not-provided" (what the 5 Oct cron run hit).
export function apifyToken(raw: string | null | undefined = process.env.APIFY_TOKEN): string {
  if (raw == null) throw new Error("APIFY_TOKEN is not set");
  const token = raw
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  if (!token) {
    throw new Error(
      "APIFY_TOKEN is set but empty (only spaces or quotes). Paste the Apify API token again in the Vercel project's environment variables (Production) and redeploy",
    );
  }
  return token;
}

async function apify<T>(path: string, init?: RequestInit): Promise<T> {
  const token = apifyToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Apify ${res.status} ${path}: ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

type Run = { id: string; status: string; defaultDatasetId: string; usageTotalUsd?: number; startedAt?: string };

// Starts a run and waits for it, rather than run-sync-get-dataset-items, so the
// run's real cost (usageTotalUsd) can be logged. maxTotalChargeUsd caps the spend.
// A run stopped by that cap still returns whatever it scraped before stopping.
// maxItems (optional) also caps pay-per-result actors, which bill per dataset item.
export async function runActor<T>(
  actor: string,
  input: unknown,
  capUsd: number,
  maxItems?: number,
): Promise<{ items: T[]; usageUsd: number; runId: string; status: string }> {
  const itemCap = maxItems ? `&maxItems=${Math.ceil(maxItems)}` : "";
  let run = (
    await apify<{ data: Run }>(`/acts/${actor}/runs?timeout=280&waitForFinish=60&maxTotalChargeUsd=${capUsd.toFixed(3)}${itemCap}`, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).data;
  while (run.status === "READY" || run.status === "RUNNING") {
    run = (await apify<{ data: Run }>(`/actor-runs/${run.id}?waitForFinish=60`)).data;
  }
  if (run.status !== "SUCCEEDED" && run.status !== "ABORTED" && run.status !== "TIMED-OUT") {
    throw new Error(`Apify run ${run.id} ended with ${run.status}`);
  }
  const items = await apify<T[]>(`/datasets/${run.defaultDatasetId}/items?clean=true`);
  // Charges settle a few seconds after the run ends, so re-read the run.
  run = (await apify<{ data: Run }>(`/actor-runs/${run.id}`)).data;
  return { items, usageUsd: run.usageTotalUsd ?? 0, runId: run.id, status: run.status };
}

// Input and dataset items of a finished run (free to read; Apify keeps them about 7 days).
export async function runItems<T, I = unknown>(runId: string): Promise<{ items: T[]; input: I }> {
  const run = (await apify<{ data: Run & { defaultKeyValueStoreId: string } }>(`/actor-runs/${runId}`)).data;
  const [items, input] = await Promise.all([
    apify<T[]>(`/datasets/${run.defaultDatasetId}/items?clean=true`),
    apify<I>(`/key-value-stores/${run.defaultKeyValueStoreId}/records/INPUT`),
  ]);
  return { items, input };
}

// A failed or timed-out run (or a network error) is retried once after RETRY_DELAY_MS.
export const RETRY_DELAY_MS = 20_000;

// postedSince (YYYY-MM-DD): only posts from that day on are returned and charged (used by the
// backfill; the daily sync leaves it out and takes each page's latest maxPosts).
export async function fetchCompanyPosts(
  urls: string[],
  maxPosts: number,
  retryDelayMs = RETRY_DELAY_MS,
  postedSince?: string,
  capUsd?: number, // hard spending cap for the run (default: 1.5x what maxPosts per page would cost)
): Promise<ApifyResult> {
  try {
    return await fetchCompanyPostsOnce(urls, maxPosts, postedSince, capUsd);
  } catch (err) {
    console.warn(`company posts run failed, retrying in ${retryDelayMs / 1000}s:`, String(err).slice(0, 200));
    await new Promise((r) => setTimeout(r, retryDelayMs));
    return fetchCompanyPostsOnce(urls, maxPosts, postedSince, capUsd);
  }
}

async function fetchCompanyPostsOnce(
  urls: string[],
  maxPosts: number,
  postedSince?: string,
  capUsd?: number,
): Promise<ApifyResult> {
  const cap = capUsd ?? urls.length * maxPosts * PRICE_PER_POST_USD * 1.5 + 0.01;
  const run = await runActor<ApifyPost>(
    ACTOR,
    { targetUrls: urls, maxPosts, includeReposts: false, ...(postedSince ? { postedLimitDate: postedSince } : {}) },
    cap,
  );
  // With an explicit cap, a run that stops at the cap still returns what it fetched.
  if (run.status !== "SUCCEEDED" && !(capUsd && run.items.length)) {
    throw new Error(`Apify run ${run.runId} ended with ${run.status}`);
  }
  // Never report less than the per-post price says it must have cost.
  const costUsd = Math.max(run.usageUsd, run.items.length * PRICE_PER_POST_USD);
  return { items: run.items.filter((i) => i.type === "post"), costUsd };
}

// Posts from this actor's recent successful runs, newest run first. Reading a dataset is
// free; Apify keeps unnamed datasets for about 7 days on the free plan.
export async function recentRunPosts(runLimit = 30): Promise<ApifyPost[]> {
  const runs = (
    await apify<{ data: { items: Run[] } }>(`/acts/${ACTOR}/runs?desc=1&limit=${runLimit}&status=SUCCEEDED`)
  ).data.items;
  const out: ApifyPost[] = [];
  for (const run of runs) {
    try {
      const items = await apify<ApifyPost[]>(`/datasets/${run.defaultDatasetId}/items?clean=true`);
      out.push(...items.filter((i) => i.type === "post"));
    } catch {
      // Dataset already expired.
    }
  }
  return out;
}

// Apify usage so far in the account's current monthly billing cycle, in USD.
export async function monthlyUsageUsd(): Promise<number> {
  return (await billingCycle()).usageUsd;
}

// Usage so far plus when the current monthly billing cycle ends.
export async function billingCycle(): Promise<{ usageUsd: number; endsAt: string }> {
  const { data } = await apify<{
    data: { current: { monthlyUsageUsd: number }; monthlyUsageCycle: { endAt: string } };
  }>("/users/me/limits");
  return { usageUsd: data.current.monthlyUsageUsd, endsAt: data.monthlyUsageCycle.endAt };
}

// "1,998,899 followers" -> 1998899. Also handles "12K followers" / "1.2M followers".
export function parseFollowers(info: string | null | undefined): number | null {
  const m = info?.match(/([\d.,]+)\s*([KM])?\s+followers?/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult = m[2]?.toUpperCase() === "M" ? 1e6 : m[2]?.toUpperCase() === "K" ? 1e3 : 1;
  return Math.round(n * mult);
}

export function mediaType(p: ApifyPost): string {
  if (p.postVideo) return "video";
  if (p.document) return "document";
  if (p.article) return "article";
  if (p.postImages?.length) return p.postImages.length > 1 ? "carousel" : "image";
  return "text";
}

export function slugFromUrl(url: string | undefined | null): string | null {
  return url?.match(/linkedin\.com\/company\/([^/?#]+)/i)?.[1]?.toLowerCase() ?? null;
}
