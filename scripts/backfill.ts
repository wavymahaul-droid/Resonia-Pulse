// One-off backfill: every tracked page's posts since a day (default 24 May 2026, six months before the
// pitch), on LinkedIn, Instagram, Facebook and X, run by hand:
//   npx tsx scripts/backfill.ts                       estimate only (prints pages, limits and worst-case cost)
//   npx tsx scripts/backfill.ts --go                  fetch and save
//   npx tsx scripts/backfill.ts --go --only instagram,x   just some platforms (e.g. to spread the cost
//                                                     over two Apify billing cycles)
//   npx tsx scripts/backfill.ts 2026-06-01 --go       from another day
//   npx tsx scripts/backfill.ts --go --dry            fetch only, write nothing (still costs Apify credit)
// Posts are saved through the same path as the daily sync (cleaning, de-duplication, thumbnails,
// themes) with posts.origin = "backfill": likes and comments are the totals on the day it ran.
// Before spending it checks this month's Apify usage and stops if the worst case would pass
// APIFY_MONTHLY_BUDGET_USD (default $4.90).
import { billingCycle, PRICE_PER_POST_USD } from "@/lib/apify";
import { BRANDS, PLATFORMS, PLATFORM_LABEL, type Segment } from "@/lib/brands";
import { PRICE_USD } from "@/lib/platforms";
import { runSync, type HistoryOptions } from "@/lib/sync";

const args = process.argv.slice(2);
const GO = args.includes("--go");
const DRY = args.includes("--dry");
const onlyArg = args[args.indexOf("--only") + 1];
const ONLY = args.includes("--only")
  ? (onlyArg.split(",") as Segment[])
  : PLATFORMS;
const SINCE = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? "2026-05-24";
const BUDGET = Number(process.env.APIFY_MONTHLY_BUDGET_USD ?? 4.9);

// Most posts any one page can return inside the window. POWERGRID posts often, so these are generous;
// pages that post less simply return less and cost less.
const MAX_POSTS: Record<Segment, number> = {
  linkedin: 200,
  instagram: 150,
  facebook: 150,
  x: 300,
};
// Per-post price (worst case) and the follower lookups that come with each page.
const PER_POST: Record<Segment, number> = {
  linkedin: PRICE_PER_POST_USD,
  instagram: PRICE_USD.igPost,
  facebook: PRICE_USD.fbPost,
  x: PRICE_USD.tweet,
};
const PER_PAGE_EXTRA: Record<Segment, number> = {
  linkedin: 0,
  instagram: PRICE_USD.igProfile,
  facebook: PRICE_USD.fbPage,
  x: 0,
};

const SLUGS = args.includes("--pages") ? args[args.indexOf("--pages") + 1].split(",") : null;
const pages = BRANDS.filter((b) => ONLY.includes(b.segment) && (!SLUGS || SLUGS.includes(b.slug)));
const caps = {} as Record<Segment, number>;
for (const p of PLATFORMS) {
  const n = pages.filter((b) => b.segment === p).length;
  caps[p] = n ? n * (MAX_POSTS[p] * PER_POST[p] + PER_PAGE_EXTRA[p]) + 0.01 : 0;
}
const worst = Object.values(caps).reduce((a, b) => a + b, 0);

console.log(`Backfill from ${SINCE} (IST) for ${pages.length} pages:`);
console.table(
  PLATFORMS.filter((p) => ONLY.includes(p)).map((p) => ({
    platform: PLATFORM_LABEL[p],
    pages:
      pages
        .filter((b) => b.segment === p)
        .map((b) => b.name.split(" · ")[0])
        .join(", ") || "-",
    "max posts per page": MAX_POSTS[p],
    "worst case $": caps[p].toFixed(2),
  })),
);
console.log(
  `Worst case: $${worst.toFixed(2)} (real cost is usually far lower: it is per post actually returned).`,
);

const cycle = await billingCycle();
console.log(
  `Apify usage this cycle: $${cycle.usageUsd.toFixed(2)} of the $${BUDGET.toFixed(2)} budget (cycle ends ${cycle.endsAt.slice(0, 10)}).`,
);
if (cycle.usageUsd + worst > BUDGET) {
  console.log(
    `\nThe worst case could pass the budget. Run fewer platforms at a time with --only (e.g. --only linkedin,x now and --only instagram,facebook next cycle), or raise APIFY_MONTHLY_BUDGET_USD if the account has more credit.`,
  );
  if (GO && !args.includes("--force-budget")) process.exit(1);
}
if (!GO) {
  console.log("\nEstimate only. Add --go to fetch and save.");
  process.exit(0);
}

const history: HistoryOptions = {
  label: `Backfill from ${SINCE} (${ONLY.map((p) => PLATFORM_LABEL[p]).join(", ")})`,
  since: SINCE,
  maxPosts: MAX_POSTS,
  capUsd: caps,
};
const summary = await runSync({ brands: pages, history, dryRun: DRY });
console.log(
  `${DRY ? "DRY RUN (nothing written) " : ""}status=${summary.status} run=${summary.runId ?? "-"}`,
);
console.table(
  summary.pages.map((p) => ({
    page: p.name,
    posts: p.posts,
    followers: p.followers ?? "-",
    ok: p.ok ? "yes" : "NO",
  })),
);
console.log(
  `Posts ${DRY ? "that would be saved" : "saved"}: ${summary.postsSaved}, thumbnails: ${summary.imagesSaved}`,
);
console.log(`Apify cost: $${summary.costUsd.toFixed(4)}`);
if (summary.notes) console.log(`Notes: ${summary.notes}`);
