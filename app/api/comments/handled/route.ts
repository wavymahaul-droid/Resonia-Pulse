import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AUTH_COOKIE, isSignedIn } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Marks a comment or X mention handled (or not). Needs sign-in with DASHBOARD_PASSWORD, checked
// here because the middleware lets everyone through when PUBLIC_DASHBOARD=true.
// Body: { comment_id, handled: true | false }. X mentions use the dashboard id "x:<tweet id>" and
// LinkedIn mentions "lim:<activity id>".
export async function POST(req: Request) {
  if (!(await isSignedIn((await cookies()).get(AUTH_COOKIE)?.value))) {
    return NextResponse.json({ error: "sign in to mark comments handled" }, { status: 401 });
  }
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "expected JSON" }, { status: 415 });
  }
  const body = (await req.json().catch(() => null)) as { comment_id?: unknown; handled?: unknown } | null;
  const id = typeof body?.comment_id === "string" ? body.comment_id : null;
  if (!id || typeof body?.handled !== "boolean") {
    return NextResponse.json({ error: "invalid comment_id or handled" }, { status: 400 });
  }
  const update = body.handled
    ? { handled: true, handled_at: new Date().toISOString(), handled_by: "team" }
    : // handled_by stays "team" so a later Resonia reply does not mark it handled again automatically.
      { handled: false, handled_at: null, handled_by: "team" };
  const tweet = id.startsWith("x:") ? id.slice(2) : null;
  const mention = id.startsWith("lim:") ? id.slice(4) : null;
  const { data, error } = mention
    ? await supabaseAdmin()
        .from("linkedin_mentions")
        .update(update)
        .eq("mention_id", mention)
        .select("mention_id,handled,handled_at,handled_by")
    : tweet
    ? await supabaseAdmin()
        .from("x_tweets")
        .update(update)
        .eq("tweet_id", tweet)
        .select("tweet_id,handled,handled_at,handled_by")
    : await supabaseAdmin()
        .from("comments")
        .update(update)
        .eq("comment_id", id)
        .select("comment_id,handled,handled_at,handled_by");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data.length) {
    return NextResponse.json({ error: mention ? "mention not found" : tweet ? "tweet not found" : "comment not found" }, { status: 404 });
  }
  return NextResponse.json(data[0]);
}
