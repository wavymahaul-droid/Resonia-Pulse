// Run the sync once by hand. Only pages that are due (see sync_every_days in brands.json) are fetched.
//   npm run sync             -> fetch from Apify and write to Supabase
//   npm run sync -- --dry    -> fetch from Apify only, print what would be saved (still costs Apify credit)
//   npm run sync -- --force  -> fetch every page even if it already synced today (to redo a failed run)
import { runSync } from "../lib/sync";

const dryRun = process.argv.includes("--dry");
const summary = await runSync({ dryRun, force: process.argv.includes("--force") });

console.log(`${dryRun ? "DRY RUN (nothing written) " : ""}status=${summary.status} run=${summary.runId ?? "-"}`);
console.table(
  summary.pages.map((p) => ({ page: p.name, posts: p.posts, followers: p.followers ?? "-", ok: p.ok ? "yes" : "NO" })),
);
console.log(`Posts ${dryRun ? "that would be saved" : "saved"}: ${summary.postsSaved}`);
console.log(`Apify cost: $${summary.costUsd.toFixed(4)}`);
if (summary.comments) console.log(`Comments: ${summary.comments.status}, ${summary.comments.commentsSaved} saved, $${summary.comments.costUsd.toFixed(4)}`);
if (summary.x) {
  const x = summary.x;
  console.log(
    `X: ${x.status}, ${x.saved.mentions} new mentions, ${x.saved.replies} new replies, ${x.saved.posts} new posts, followers ${x.followers ?? "-"}, $${x.costUsd.toFixed(4)}`,
  );
}
if (summary.notes) console.log(`Notes: ${summary.notes}`);
