// Saves an uploaded LinkedIn analytics export (see lib/liexport.ts): per-post numbers matched to
// tracked Resonia posts, and daily page numbers by date. A post the tracker has not seen becomes a
// post record of its own (origin "export": opening text and date only); the daily sync folds it
// into the full post if it finds it later (lib/sync.ts). Server only. No Apify calls.
import type { SupabaseClient } from "@supabase/supabase-js";
import { BRANDS } from "@/lib/brands";
import { exportMediaType, isAdRow, matchPost, type ParsedExport, type StoredPost } from "@/lib/liexport";
import { fillFollowerGrowth, monthsOf, type FillResult } from "@/lib/history";
import { tagTheme } from "@/lib/themes";
import { clip, sanitiseRow } from "@/lib/sanitise";

export const MONTRA_PAGES = BRANDS.filter((b) => b.is_montra).map((b) => ({ id: b.slug, name: b.name }));

export type UploadResult = {
  file: string;
  page: string | null;
  kinds: string[];
  rows: number;
  matched: number;
  created: number; // posts created from export rows that matched no tracked post
  ads: number; // of those (and earlier ones), labelled "Ad (not on feed)"
  followerGrowth?: FillResult[]; // months whose follower growth was filled in the report history
  unmatched: { title: string; created: string | null; link: string }[];
  otherPage: number; // posts matched on another Resonia page than the one picked
  dateFrom: string | null;
  dateTo: string | null;
  warnings: string[];
};

const int = (n: number | null | undefined) => (n == null ? null : Math.round(n));

export async function saveExport(
  db: SupabaseClient,
  parsed: ParsedExport,
  { page, file }: { page: string | null; file: string },
): Promise<UploadResult> {
  const result: UploadResult = {
    file,
    page,
    kinds: parsed.kinds,
    rows: parsed.posts.length + parsed.daily.length,
    matched: 0,
    created: 0,
    ads: 0,
    unmatched: [],
    otherPage: 0,
    dateFrom: parsed.dateFrom,
    dateTo: parsed.dateTo,
    warnings: [...parsed.warnings],
  };
  const now = new Date().toISOString();
  // The organic / sponsored columns only exist once supabase/schema.sql has been re-run.
  const split = !(await db.from("li_page_metrics").select("impressions_organic").limit(1)).error;
  if (!split && (parsed.posts.length || parsed.daily.some((d) => "impressions_organic" in d)))
    result.warnings.push(
      "Re-run supabase/schema.sql so organic and sponsored numbers are kept apart, then upload the Content export again.",
    );
  const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10); // IST

  if (parsed.posts.length) {
    // Resonia posts around the export's dates (a week either side).
    const montraIds = MONTRA_PAGES.map((p) => p.id);
    const from = parsed.dateFrom ? new Date(Date.parse(parsed.dateFrom) - 8 * 86_400_000).toISOString() : null;
    // posts.origin only exists once supabase/schema.sql has been re-run.
    const canCreate = !(await db.from("posts").select("origin").limit(1)).error;
    let q = db
      .from("posts")
      .select(`post_url,brand_id,linkedin_id,posted_at,text${canCreate ? ",origin" : ""}`)
      .in("brand_id", montraIds);
    if (from) q = q.gte("posted_at", from);
    const { data, error } = await q.limit(5000);
    if (error) throw new Error(`posts select: ${error.message}`);
    const stored = (data ?? []) as unknown as StoredPost[];
    const newPosts: Record<string, unknown>[] = [];
    const toAd: string[] = []; // earlier export posts that this export shows are ads
    const snapshots: Record<string, unknown>[] = [];
    const rows = parsed.posts.map((r) => {
      let hit = matchPost(r, stored);
      if (hit) {
        result.matched++;
        if (page && hit.brand_id !== page) result.otherPage++;
        if (hit.origin === "export" && isAdRow(r)) {
          toAd.push(hit.post_url);
          result.ads++;
        }
      } else if (canCreate && page && r.created) {
        // A post the tracker never saw (older, or missed): keep it as a post of its own. Resonia's
        // campaigns run as dark posts, so one marked sponsored or without a feed link is an ad.
        const origin = isAdRow(r) ? "ad" : "export";
        if (origin === "ad") result.ads++;
        newPosts.push({
          post_url: r.link,
          brand_id: page,
          linkedin_id: r.ids[0] ?? null,
          posted_at: `${r.created}T12:00:00+05:30`, // the export has the date only
          text: r.title,
          media_type: exportMediaType(r.contentType),
          theme: tagTheme(r.title),
          origin,
        });
        hit = { post_url: r.link, brand_id: page, linkedin_id: r.ids[0] ?? null, posted_at: null, text: r.title, origin };
        result.created++;
      } else {
        result.unmatched.push({ title: r.title.slice(0, 80), created: r.created, link: r.link });
      }
      // Posts known only from exports take their likes, comments and reposts from the export.
      if (hit?.origin === "export" || hit?.origin === "ad") {
        snapshots.push({
          post_url: hit.post_url,
          date: today,
          likes: int(r.reactions) ?? 0,
          comments: int(r.comments) ?? 0,
          reposts: int(r.reposts) ?? 0,
        });
      }
      return {
        export_link: r.link,
        post_url: hit?.post_url ?? null,
        brand_id: hit?.brand_id ?? page,
        created_date: r.created,
        title: clip(r.title, 300),
        impressions: int(r.impressions),
        clicks: int(r.clicks),
        ctr: r.ctr,
        reactions: int(r.reactions),
        comments: int(r.comments),
        reposts: int(r.reposts),
        engagement_rate: r.engagementRate,
        ...(split ? { post_type: r.postType, sponsored: r.sponsored, raw: r.raw } : {}),
        uploaded_at: now,
      };
    });
    if (newPosts.length) {
      const { error: e } = await db.from("posts").upsert(newPosts.map((r) => sanitiseRow(r)), { onConflict: "post_url" });
      if (e) throw new Error(`posts upsert: ${e.message}`);
    }
    if (toAd.length) {
      const { error: e } = await db.from("posts").update({ origin: "ad" }).in("post_url", toAd).eq("origin", "export");
      if (e) throw new Error(`posts ad update: ${e.message}`);
    }
    if (snapshots.length) {
      const { error: e } = await db.from("post_snapshots").upsert(snapshots.map((r) => sanitiseRow(r)), { onConflict: "post_url,date" });
      if (e) throw new Error(`post_snapshots upsert: ${e.message}`);
    }
    if (!canCreate && result.unmatched.length)
      result.warnings.push(
        "Re-run supabase/schema.sql to add posts the tracker has not seen from the export (it adds posts.origin).",
      );
    const keep = rows.filter((r) => r.brand_id);
    if (keep.length < rows.length)
      result.warnings.push(
        `${rows.length - keep.length} posts matched no tracked post and no page was picked, so they were not saved. Pick the page and upload again.`,
      );
    if (keep.length) {
      const { error: e } = await db
        .from("li_post_metrics")
        .upsert(keep.map((r) => sanitiseRow(r, ["raw"])), { onConflict: "export_link" });
      if (e) throw new Error(`li_post_metrics upsert: ${e.message}`);
    }
  }

  if (parsed.daily.length) {
    if (!page) {
      result.warnings.push("Daily page numbers were not saved: pick which Resonia page this file is for.");
    } else {
      const rows = parsed.daily.map((d) => {
        const row: Record<string, string | number | null> = { brand_id: page, date: d.date, updated_at: now };
        for (const [k, v] of Object.entries(d)) {
          if (k === "date" || (!split && /_(organic|sponsored)$/.test(k) && !k.startsWith("new_followers"))) continue;
          row[k] = k === "engagement_rate" ? (v ?? null) : int(v as number | null);
        }
        return row;
      });
      // Upsert in batches (each row cleaned, lib/sanitise.ts); only the columns this file has are written, so a Followers upload
      // does not wipe the impressions from a Content upload for the same days.
      const byShape = new Map<string, typeof rows>();
      for (const r of rows) {
        const key = Object.keys(r).sort().join(",");
        byShape.set(key, [...(byShape.get(key) ?? []), r]);
      }
      for (const list of byShape.values()) {
        for (let i = 0; i < list.length; i += 500) {
          const { error } = await db
            .from("li_page_metrics")
            .upsert(list.slice(i, i + 500).map((r) => sanitiseRow(r)), { onConflict: "brand_id,date" });
          if (error) throw new Error(`li_page_metrics upsert: ${error.message}`);
        }
      }
    }
  }

  // Follower growth in the monthly report history, for each full month this file covers.
  if (page && parsed.kinds.includes("followers")) {
    const filled = await fillFollowerGrowth(db, page, monthsOf(parsed.daily.map((d) => d.date)));
    result.followerGrowth = filled.filter((f) => f.action === "added" || f.action === "updated");
  }

  const { error } = await db.from("li_uploads").insert({
    brand_id: page,
    file_name: clip(file, 200),
    kinds: parsed.kinds.join(","),
    rows_read: result.rows,
    posts_matched: result.matched,
    posts_unmatched: result.unmatched.length,
    date_from: parsed.dateFrom,
    date_to: parsed.dateTo,
  });
  if (error) throw new Error(`li_uploads insert: ${error.message}`);
  return result;
}
