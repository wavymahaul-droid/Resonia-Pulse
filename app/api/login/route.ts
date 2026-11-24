import { NextResponse } from "next/server";
import { AUTH_COOKIE, AUTH_MAX_AGE, authToken, safeEqual } from "@/lib/auth";

export async function POST(req: Request) {
  const form = await req.formData();
  const given = String(form.get("password") ?? "");
  const password = process.env.DASHBOARD_PASSWORD;
  const ok = !!password && safeEqual(await authToken(given), await authToken(password));
  // 303 so the browser follows with a GET.
  const res = NextResponse.redirect(new URL(ok ? "/" : "/login?error=1", req.url), 303);
  if (ok) {
    res.cookies.set(AUTH_COOKIE, await authToken(password), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: AUTH_MAX_AGE,
    });
  } else {
    // Slow down guessing a little.
    await new Promise((r) => setTimeout(r, 800));
  }
  return res;
}
