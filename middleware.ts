import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, isPublicDashboard, isSignedIn } from "@/lib/auth";

// Everything except the login page, the login/logout endpoints, the cron endpoint
// (protected by CRON_SECRET), the ORM digest (protected by ORM_DIGEST_KEY) and static assets
// needs the shared password, unless PUBLIC_DASHBOARD=true. The theme edit API checks sign-in itself, so it stays
// protected in public mode too.
export const config = {
  matcher: ["/((?!login|api/login|api/logout|api/cron|api/orm-digest|_next/static|_next/image|favicon.ico).*)"],
};

export async function middleware(req: NextRequest) {
  if (isPublicDashboard()) return NextResponse.next();
  // With no password configured the dashboard stays locked rather than open.
  if (await isSignedIn(req.cookies.get(AUTH_COOKIE)?.value)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}
