import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AUTH_COOKIE, isSignedIn } from "@/lib/auth";
import { DECK_PAGES, isMonth } from "@/lib/monthly";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const FIELDS = ["follower_growth", "engagement", "impressions", "posts"] as const;

// Saves one page's month in the monthly report history. Needs sign-in with DASHBOARD_PASSWORD,
// checked here because the middleware lets everyone through when PUBLIC_DASHBOARD=true.
// Body: { brand_id, month: "YYYY-MM", follower_growth, engagement, impressions, posts } (whole
// numbers or null). All four null removes the month, so the uploaded exports are used again.
export async function POST(req: Request) {
  if (!(await isSignedIn((await cookies()).get(AUTH_COOKIE)?.value))) {
    return NextResponse.json({ error: "sign in to edit the report history" }, { status: 401 });
  }
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "expected JSON" }, { status: 415 });
  }
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const brand = body?.brand_id;
  const month = body?.month;
  const valid = (v: unknown) => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 1e10);
  if (
    typeof brand !== "string" ||
    !DECK_PAGES.some((p) => p.id === brand) ||
    typeof month !== "string" ||
    !isMonth(month) ||
    !FIELDS.every((f) => valid(body?.[f]))
  ) {
    return NextResponse.json({ error: "invalid brand_id, month or numbers" }, { status: 400 });
  }
  const db = supabaseAdmin();
  const hint = (m: string) => (/report_history/.test(m) ? `${m} (re-run supabase/schema.sql)` : m);
  if (FIELDS.every((f) => body?.[f] === null)) {
    const { error } = await db.from("report_history").delete().eq("brand_id", brand).eq("month", month);
    if (error) return NextResponse.json({ error: hint(error.message) }, { status: 500 });
    return NextResponse.json({ removed: true });
  }
  const row = {
    brand_id: brand,
    month,
    ...Object.fromEntries(FIELDS.map((f) => [f, body?.[f]])),
    updated_at: new Date().toISOString(),
  };
  // A figure typed in by hand is no longer the exports' (later uploads leave it alone).
  let res = await db
    .from("report_history")
    .upsert({ ...row, follower_growth_from_export: false }, { onConflict: "brand_id,month" })
    .select();
  if (res.error && /follower_growth_from_export/.test(res.error.message))
    res = await db.from("report_history").upsert(row, { onConflict: "brand_id,month" }).select();
  if (res.error) return NextResponse.json({ error: hint(res.error.message) }, { status: 500 });
  return NextResponse.json(res.data[0]);
}
