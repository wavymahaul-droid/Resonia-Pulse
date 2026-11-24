import { NextResponse } from "next/server";
import { IMAGE_BUCKET } from "@/lib/images";
import { supabaseAdmin } from "@/lib/supabase";
import { zip } from "@/lib/zip";

export const dynamic = "force-dynamic";

const MAX_FILES = 12;

// "Download thumbnails" on the Report page: the saved thumbnails of the listed posts as one .zip.
// Thumbnails are of company posts (Resonia's and competitors'), so the public view may download them
// too. Body: { files: [{ post_url, name }] }. Posts without a saved thumbnail are skipped and
// counted in the X-Missing header.
export async function POST(req: Request) {
  if (!req.headers.get("content-type")?.includes("application/json")) {
    return NextResponse.json({ error: "expected JSON" }, { status: 415 });
  }
  const body = (await req.json().catch(() => null)) as { files?: unknown } | null;
  const files = Array.isArray(body?.files) ? (body.files as { post_url?: unknown; name?: unknown }[]) : [];
  const list = files
    .filter((f) => typeof f?.post_url === "string" && typeof f?.name === "string")
    .slice(0, MAX_FILES)
    .map((f) => ({ url: f.post_url as string, name: (f.name as string).replace(/[^a-z0-9._-]/gi, "-").slice(0, 80) }));
  if (!list.length) return NextResponse.json({ error: "no posts" }, { status: 400 });

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("posts")
    .select("post_url,image_path")
    .in(
      "post_url",
      list.map((f) => f.url),
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const path = new Map((data ?? []).map((p) => [p.post_url as string, p.image_path as string | null]));
  const out: { name: string; data: Uint8Array }[] = [];
  for (const f of list) {
    const p = path.get(f.url);
    if (!p) continue;
    const { data: blob } = await db.storage.from(IMAGE_BUCKET).download(p);
    if (!blob) continue;
    const ext = p.split(".").pop() || "webp";
    out.push({ name: `${f.name}.${ext}`, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  if (!out.length) return NextResponse.json({ error: "none of these posts has a saved thumbnail" }, { status: 404 });
  return new NextResponse(zip(out) as BodyInit, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="thumbnails.zip"',
      "X-Missing": String(list.length - out.length),
    },
  });
}
