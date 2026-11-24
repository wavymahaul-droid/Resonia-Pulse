// Post thumbnails. LinkedIn's image URLs expire after a few days, so the first time a
// post is seen one image is downloaded, shrunk to at most 600px wide and kept in a
// private Supabase Storage bucket. posts.image_path holds the object path.
import sharp from "sharp";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApifyPost } from "@/lib/apify";

export const IMAGE_BUCKET = "post-images";
const MAX_WIDTH = 600;
const QUALITY = 72; // WebP quality: about 30-70 KB per thumbnail
const CONCURRENCY = 4;

// The one image to keep: video thumbnail, document cover, or the first post image.
// Text posts and article link previews have none.
export function imageSource(p: ApifyPost): string | null {
  if (p.postVideo) return p.postVideo.thumbnailUrl ?? null;
  if (p.document) return p.document.coverPages?.[0]?.imageUrls?.[0] ?? null;
  if (p.article) return null;
  return p.postImages?.[0]?.url ?? null;
}

export async function ensureBucket(db: SupabaseClient): Promise<void> {
  const { error } = await db.storage.getBucket(IMAGE_BUCKET);
  if (!error) return;
  const { error: createErr } = await db.storage.createBucket(IMAGE_BUCKET, {
    public: false,
    fileSizeLimit: 1024 * 1024,
    allowedMimeTypes: ["image/webp"],
  });
  if (createErr && !/already exists/i.test(createErr.message)) {
    throw new Error(`storage bucket ${IMAGE_BUCKET}: ${createErr.message}`);
  }
}

export async function thumbnail(input: Buffer): Promise<Buffer> {
  return sharp(input)
    .rotate()
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer();
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ResoniaPulse/1.0)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export type ThumbJob = { post_url: string; brand_id: string; linkedin_id: string | null; src: string };
export type ThumbResult = { saved: number; failed: { post_url: string; error: string }[] };

function objectPath(job: ThumbJob): string {
  const id = job.linkedin_id || job.post_url.replace(/[^a-z0-9]+/gi, "-").slice(-80);
  return `${job.brand_id}/${id}.webp`;
}

// Downloads, shrinks and uploads each image, then records image_path on the post.
// A failed image (usually an expired URL) is reported and skipped.
export async function saveThumbnails(db: SupabaseClient, jobs: ThumbJob[]): Promise<ThumbResult> {
  const result: ThumbResult = { saved: 0, failed: [] };
  if (!jobs.length) return result;
  await ensureBucket(db);
  const queue = [...jobs];
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        const path = objectPath(job);
        const body = await thumbnail(await download(job.src));
        const { error: upErr } = await db.storage
          .from(IMAGE_BUCKET)
          .upload(path, body, { contentType: "image/webp", upsert: true, cacheControl: "31536000" });
        if (upErr) throw new Error(`upload: ${upErr.message}`);
        const { error } = await db.from("posts").update({ image_path: path }).eq("post_url", job.post_url);
        if (error) throw new Error(`posts update: ${error.message}`);
        result.saved++;
      } catch (err) {
        result.failed.push({ post_url: job.post_url, error: err instanceof Error ? err.message : String(err) });
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return result;
}

// Posts among `urls` that have no thumbnail yet.
export async function postsWithoutImage(db: SupabaseClient, urls: string[]): Promise<Set<string>> {
  const missing = new Set<string>();
  for (let i = 0; i < urls.length; i += 100) {
    const { data, error } = await db
      .from("posts")
      .select("post_url")
      .in("post_url", urls.slice(i, i + 100))
      .is("image_path", null);
    if (error) throw new Error(`posts select: ${error.message}`);
    for (const r of data) missing.add(r.post_url);
  }
  return missing;
}

// Short-lived signed URLs for the dashboard (the bucket is private).
export async function signedImageUrls(db: SupabaseClient, paths: string[], ttlSeconds = 86_400): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const { data, error } = await db.storage.from(IMAGE_BUCKET).createSignedUrls(paths, ttlSeconds);
  if (error) return out; // Missing bucket: posts just show no image.
  for (const d of data) if (d.path && d.signedUrl) out.set(d.path, d.signedUrl);
  return out;
}
