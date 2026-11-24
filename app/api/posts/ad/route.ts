import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AUTH_COOKIE, isSignedIn } from "@/lib/auth";
import { isAd } from "@/lib/dashboard";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Marks a post as organic or as an ad (not on the feed) by hand. Needs sign-in with
// DASHBOARD_PASSWORD, checked here because the middleware lets everyone through when
// PUBLIC_DASHBOARD=true. Body: { post_url, ad: true | false }, or { post_url, ad: null } to go
// back to the automatic rule. Returns { ad, ad_manual }.
export async function POST(req: Request) {
  if (!(await isSignedIn((await cookies()).get(AUTH_COOKIE)?.value))) {
    return NextResponse.json({ error: "sign in to mark posts" }, { status: 401 });
  }
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "expected JSON" }, { status: 415 });
  }
  const body = (await req.json().catch(() => null)) as { post_url?: unknown; ad?: unknown } | null;
  const postUrl = typeof body?.post_url === "string" ? body.post_url : null;
  const ad = body?.ad;
  if (!postUrl || (ad !== null && typeof ad !== "boolean")) {
    return NextResponse.json({ error: "invalid post_url or ad" }, { status: 400 });
  }

  const db = supabaseAdmin();
  const update = ad === null ? { is_ad: false, ad_manual: false } : { is_ad: ad, ad_manual: true };
  const { data, error } = await db
    .from("posts")
    .update(update)
    .eq("post_url", postUrl)
    .select("origin,is_ad,ad_manual");
  if (error) {
    const hint = /is_ad|ad_manual/.test(error.message) ? " (re-run supabase/schema.sql)" : "";
    return NextResponse.json({ error: error.message + hint }, { status: 500 });
  }
  if (!data.length) return NextResponse.json({ error: "post not found" }, { status: 404 });
  return NextResponse.json({ ad: isAd(data[0]), ad_manual: data[0].ad_manual });
}
