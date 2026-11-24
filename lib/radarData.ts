// Reads the Industry Radar for the pages. Server only. In the public view the "Why it matters" notes
// and the feed status are left out.
import type { SupabaseClient } from "@supabase/supabase-js";
import { withTags, type RadarItem } from "@/lib/radar";

export type FeedRow = {
  name: string;
  url: string;
  ok: boolean;
  items: number;
  error: string | null;
  checked_at: string;
};
export type RadarData = { ready: boolean; items: RadarItem[]; feeds: FeedRow[]; lastChecked: string | null };

export async function loadRadar(
  db: SupabaseClient,
  { publicView = false, limit = 1000 }: { publicView?: boolean; limit?: number } = {},
): Promise<RadarData> {
  const cols = `url,title,source,snippet,published_at,query${publicView ? "" : ",note"}`;
  const { data, error } = await db
    .from("radar_items")
    .select(cols)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(limit)
    .returns<Omit<RadarItem, "type" | "relevance" | "pages" | "competitor">[]>();
  // Until schema.sql adds the tables.
  if (error) return { ready: false, items: [], feeds: [], lastChecked: null };
  const feeds = await db
    .from("radar_feeds")
    .select("name,url,ok,items,error,checked_at")
    .order("name")
    .returns<FeedRow[]>();
  const rows = feeds.data ?? [];
  return {
    ready: true,
    items: withTags(data ?? []),
    feeds: publicView ? [] : rows,
    lastChecked:
      rows
        .map((f) => f.checked_at)
        .sort()
        .at(-1) ?? null,
  };
}
