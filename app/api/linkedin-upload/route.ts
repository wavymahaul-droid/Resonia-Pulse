import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { AUTH_COOKIE, isSignedIn } from "@/lib/auth";
import { pageFromFileName, parseExport } from "@/lib/liexport";
import { MONTRA_PAGES, saveExport, type UploadResult } from "@/lib/liupload";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const MAX_BYTES = 4 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB
const OK_EXT = /\.(xls|xlsx|csv)$/i;

// Uploads LinkedIn page analytics exports (Content, Followers, Visitors). Needs sign-in, checked
// here because the middleware lets everyone through when PUBLIC_DASHBOARD=true.
// multipart/form-data: page = a Resonia page id or "auto" (from the file name), files = one or more files.
export async function POST(req: Request) {
  if (!(await isSignedIn((await cookies()).get(AUTH_COOKIE)?.value))) {
    return NextResponse.json({ error: "sign in to upload LinkedIn analytics" }, { status: 401 });
  }
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "expected a file upload" }, { status: 415 });
  const pageField = String(form.get("page") ?? "auto");
  if (pageField !== "auto" && !MONTRA_PAGES.some((p) => p.id === pageField)) {
    return NextResponse.json({ error: "unknown page" }, { status: 400 });
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (!files.length) return NextResponse.json({ error: "no files" }, { status: 400 });

  const db = supabaseAdmin();
  const { error: tableError } = await db.from("li_uploads").select("id").limit(1);
  if (tableError) {
    return NextResponse.json(
      { error: "Re-run supabase/schema.sql in Supabase first (it adds the LinkedIn analytics tables)." },
      { status: 503 },
    );
  }

  const results: (UploadResult | { file: string; error: string })[] = [];
  for (const f of files) {
    if (!OK_EXT.test(f.name)) {
      results.push({ file: f.name, error: "Only .xls, .xlsx and .csv files exported from LinkedIn." });
      continue;
    }
    if (f.size > MAX_BYTES) {
      results.push({ file: f.name, error: "File is larger than 4 MB." });
      continue;
    }
    try {
      const parsed = parseExport(Buffer.from(await f.arrayBuffer()), f.name);
      const page = pageField === "auto" ? pageFromFileName(f.name, MONTRA_PAGES) : pageField;
      results.push(await saveExport(db, parsed, { page, file: f.name }));
    } catch (e) {
      results.push({ file: f.name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ results });
}
