import { NextResponse } from "next/server";
import { runSync } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Called daily by Vercel Cron (vercel.json), which sends `Authorization: Bearer $CRON_SECRET`.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const summary = await runSync();
    return NextResponse.json(summary);
  } catch (err) {
    console.error("sync failed", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
