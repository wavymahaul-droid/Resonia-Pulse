// Folds posts created from an uploaded LinkedIn export (posts.origin = "export" or "ad": opening text
// and date only) into the full post when the daily sync finds the same post. A post found on the feed
// is organic, so an "Ad (not on feed)" that turns up there is folded in too. The sync's record wins
// (full text, posting time, image); the export's impressions and clicks move over to it.
import type { SupabaseClient } from "@supabase/supabase-js";
import { samePost, type StoredPost } from "@/lib/liexport";

type ExportPost = StoredPost & { theme: string | null; theme_manual?: boolean | null };

// Pairs of (export post, synced post) that are the same LinkedIn post.
export function exportMerges(exportPosts: ExportPost[], synced: StoredPost[]): { from: ExportPost; to: StoredPost }[] {
  const out: { from: ExportPost; to: StoredPost }[] = [];
  for (const e of exportPosts) {
    const hits = synced.filter((s) => s.post_url !== e.post_url && samePost(e, s));
    if (hits.length === 1) out.push({ from: e, to: hits[0] });
  }
  return out;
}

export async function mergeExportPosts(db: SupabaseClient, synced: StoredPost[]): Promise<number> {
  const brands = [...new Set(synced.map((s) => s.brand_id))];
  if (!brands.length) return 0;
  const { data, error } = await db
    .from("posts")
    .select("post_url,brand_id,linkedin_id,posted_at,text,theme,theme_manual")
    .in("origin", ["export", "ad"])
    .in("brand_id", brands);
  if (error) throw new Error(`export posts select: ${error.message}`);
  const merges = exportMerges((data ?? []) as ExportPost[], synced);
  for (const { from, to } of merges) {
    // The export's impressions, clicks and CTR now belong to the synced post.
    const { error: e1 } = await db
      .from("li_post_metrics")
      .update({ post_url: to.post_url })
      .eq("post_url", from.post_url);
    if (e1) throw new Error(`li_post_metrics re-point: ${e1.message}`);
    // A theme set by hand on the export post is kept.
    if (from.theme_manual && from.theme) {
      const { error: e2 } = await db
        .from("posts")
        .update({ theme: from.theme, theme_manual: true })
        .eq("post_url", to.post_url);
      if (e2) throw new Error(`posts theme update: ${e2.message}`);
    }
    // Its snapshots go with it (on delete cascade).
    const { error: e3 } = await db.from("posts").delete().eq("post_url", from.post_url).in("origin", ["export", "ad"]);
    if (e3) throw new Error(`export post delete: ${e3.message}`);
  }
  return merges.length;
}
