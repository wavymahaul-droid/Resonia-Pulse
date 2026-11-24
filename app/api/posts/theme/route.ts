import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AUTH_COOKIE, isSignedIn } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { THEMES, tagTheme } from "@/lib/themes";

export const dynamic = "force-dynamic";

// Sets a post's theme by hand. Needs sign-in with DASHBOARD_PASSWORD, checked here
// because the middleware lets everyone through when PUBLIC_DASHBOARD=true.
// Body: { post_url, theme } to set it, or { post_url, theme: null } to go back to the
// keyword rules. Hand-set themes are marked theme_manual, so `npm run retag` keeps them.
export async function POST(req: Request) {
  if (!(await isSignedIn((await cookies()).get(AUTH_COOKIE)?.value))) {
    return NextResponse.json({ error: "sign in to edit themes" }, { status: 401 });
  }
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "expected JSON" }, { status: 415 });
  }
  const body = (await req.json().catch(() => null)) as { post_url?: unknown; theme?: unknown } | null;
  const postUrl = typeof body?.post_url === "string" ? body.post_url : null;
  const theme = body?.theme;
  if (!postUrl || (theme !== null && (typeof theme !== "string" || !THEMES.includes(theme)))) {
    return NextResponse.json({ error: "invalid post_url or theme" }, { status: 400 });
  }

  const db = supabaseAdmin();
  let update: { theme: string; theme_manual: boolean };
  if (theme === null) {
    const { data, error } = await db.from("posts").select("text").eq("post_url", postUrl).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "post not found" }, { status: 404 });
    update = { theme: tagTheme(data.text), theme_manual: false };
  } else {
    update = { theme, theme_manual: true };
  }

  const { data, error } = await db.from("posts").update(update).eq("post_url", postUrl).select("theme,theme_manual");
  if (error) {
    const hint = /theme_manual/.test(error.message) ? " (re-run supabase/schema.sql)" : "";
    return NextResponse.json({ error: error.message + hint }, { status: 500 });
  }
  if (!data.length) return NextResponse.json({ error: "post not found" }, { status: 404 });
  return NextResponse.json(data[0]);
}
