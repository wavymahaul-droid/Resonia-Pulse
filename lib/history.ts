// Fills report_history's follower growth (the monthly client report) from the uploaded Followers
// exports: LinkedIn's total new followers per page for each month the exports cover in full.
// A figure entered by hand (or from an earlier deck) is never overwritten; one filled from the
// exports is updated when a later upload changes it. Server only.
import type { SupabaseClient } from "@supabase/supabase-js";
import { daysInMonth, monthRange } from "@/lib/monthly";

export type FillResult = {
  brand: string;
  month: string;
  value: number | null; // LinkedIn new followers (total) for the month
  action: "added" | "updated" | "unchanged" | "kept entered figure" | "partial month" | "no table";
  entered?: number | null; // the hand-entered figure that was kept
};

export async function fillFollowerGrowth(db: SupabaseClient, brand: string, months: string[]): Promise<FillResult[]> {
  const out: FillResult[] = [];
  const table = await db.from("report_history").select("brand_id").limit(1);
  // follower_growth_from_export arrives with a later schema.sql; without it, only empty cells are filled.
  const flagCol = !(await db.from("report_history").select("follower_growth_from_export").limit(1)).error;
  for (const month of [...new Set(months)].sort()) {
    const r = monthRange(month);
    const { data, error } = await db
      .from("li_page_metrics")
      .select("date,new_followers")
      .eq("brand_id", brand)
      .gte("date", r.from)
      .lte("date", r.to)
      .not("new_followers", "is", null);
    if (error) throw new Error(`li_page_metrics select: ${error.message}`);
    const days = new Set((data ?? []).map((d) => d.date)).size;
    const value = (data ?? []).reduce((a, d) => a + (d.new_followers as number), 0);
    if (days < daysInMonth(month)) {
      out.push({ brand, month, value: days ? value : null, action: "partial month" });
      continue;
    }
    if (table.error) {
      out.push({ brand, month, value, action: "no table" });
      continue;
    }
    const cols: string = `follower_growth${flagCol ? ",follower_growth_from_export" : ""}`;
    const { data: rows, error: e1 } = await db
      .from("report_history")
      .select(cols)
      .eq("brand_id", brand)
      .eq("month", month);
    if (e1) throw new Error(`report_history select: ${e1.message}`);
    const row = rows?.[0] as unknown as
      | { follower_growth: number | null; follower_growth_from_export?: boolean }
      | undefined;
    const flag = flagCol ? { follower_growth_from_export: true } : {};
    if (!row) {
      const { error: e2 } = await db
        .from("report_history")
        .insert({ brand_id: brand, month, follower_growth: value, ...flag });
      if (e2) throw new Error(`report_history insert: ${e2.message}`);
      out.push({ brand, month, value, action: "added" });
    } else if (row.follower_growth == null || row.follower_growth_from_export) {
      if (row.follower_growth === value) {
        out.push({ brand, month, value, action: "unchanged" });
        continue;
      }
      const { error: e3 } = await db
        .from("report_history")
        .update({ follower_growth: value, ...flag, updated_at: new Date().toISOString() })
        .eq("brand_id", brand)
        .eq("month", month);
      if (e3) throw new Error(`report_history update: ${e3.message}`);
      out.push({ brand, month, value, action: "updated" });
    } else {
      out.push({
        brand,
        month,
        value,
        action: row.follower_growth === value ? "unchanged" : "kept entered figure",
        entered: row.follower_growth,
      });
    }
  }
  return out;
}

// The months (YYYY-MM) a list of dates touches.
export const monthsOf = (dates: string[]) => [...new Set(dates.map((d) => d.slice(0, 7)))];
