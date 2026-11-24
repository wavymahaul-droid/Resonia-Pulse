import { cookies } from "next/headers";
import TopPosts, { type TopView } from "@/app/TopPosts";
import { AUTH_COOKIE, isPublicDashboard, isSignedIn } from "@/lib/auth";
import { loadDashboard } from "@/lib/dashboard";
import { istToday, loadSince, rangeFromParams } from "@/lib/range";

export const dynamic = "force-dynamic";
export const metadata = { title: "Top posts · Resonia Pulse" };

type Params = { range?: string; from?: string; to?: string; view?: string; page?: string };

// Top Resonia and competitor posts, and our top X posts, over a date range (IST): ?range=7d, or
// ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD (default: the last 30 days), plus ?view=pages for the
// By page view and ?page=<brand id> for one page. Stored data only.
export default async function TopPage({ searchParams }: { searchParams: Promise<Params> }) {
  const [jar, params] = await Promise.all([cookies(), searchParams]);
  const signedIn = await isSignedIn(jar.get(AUTH_COOKIE)?.value);
  const range = rangeFromParams(params, istToday(), "30d");
  // Same rules as the dashboard: names and contact details of people only for signed-in viewers.
  const data = await loadDashboard({ publicView: isPublicDashboard() && !signedIn, since: loadSince(range) });
  const view: TopView = params.view === "pages" ? "pages" : "overall";
  return <TopPosts data={data} initialRange={range} initialView={view} initialPage={params.page ?? null} />;
}
