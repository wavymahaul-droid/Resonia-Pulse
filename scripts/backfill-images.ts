// Save thumbnails for posts already in the database that have none yet.
// Image links come from the actor's recent Apify runs (reading them costs no credit).
// Apify keeps run data about 7 days and LinkedIn's links expire too, so older posts
// may have no source left; those stay without an image.
//   npm run backfill-images
import { recentRunPosts } from "../lib/apify";
import { imageSource, saveThumbnails, type ThumbJob } from "../lib/images";
import { supabaseAdmin } from "../lib/supabase";

const db = supabaseAdmin();

const { data: rows, error } = await db
  .from("posts")
  .select("post_url,brand_id,linkedin_id,media_type")
  .is("image_path", null)
  .not("media_type", "in", "(text,article)");
if (error) throw new Error(`posts select: ${error.message} (re-run supabase/schema.sql first)`);

// Newest run first, so the freshest link for each post wins.
const src = new Map<string, string>();
for (const p of await recentRunPosts()) {
  const url = imageSource(p);
  if (url && !src.has(p.linkedinUrl)) src.set(p.linkedinUrl, url);
}

const jobs: ThumbJob[] = rows
  .filter((r) => src.has(r.post_url))
  .map((r) => ({ post_url: r.post_url, brand_id: r.brand_id, linkedin_id: r.linkedin_id, src: src.get(r.post_url)! }));
const result = await saveThumbnails(db, jobs);

console.log(`Posts without a thumbnail: ${rows.length}`);
console.log(`Saved: ${result.saved}`);
console.log(`No image link left on Apify: ${rows.length - jobs.length}`);
console.log(`Download or upload failed: ${result.failed.length}`);
for (const f of result.failed.slice(0, 10)) console.log(`  ${f.post_url}: ${f.error}`);
