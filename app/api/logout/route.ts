import { NextResponse } from "next/server";
import { AUTH_COOKIE, isPublicDashboard } from "@/lib/auth";

export async function POST(req: Request) {
  // In public mode signing out just drops back to the read-only dashboard.
  const res = NextResponse.redirect(new URL(isPublicDashboard() ? "/" : "/login", req.url), 303);
  res.cookies.delete(AUTH_COOKIE);
  return res;
}
