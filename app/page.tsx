import { cookies } from "next/headers";
import Dashboard, { type Tab } from "@/app/Dashboard";
import { AUTH_COOKIE, isPublicDashboard, isSignedIn } from "@/lib/auth";
import { loadDashboard } from "@/lib/dashboard";
import { ORM_ENABLED } from "@/lib/brands";
import { istToday, loadSince, rangeFromParams } from "@/lib/range";

// Always read fresh data. The middleware has already checked the password, or let
// the request through because PUBLIC_DASHBOARD=true.
export const dynamic = "force-dynamic";

type Params = { range?: string; from?: string; to?: string; tab?: string };

// ?range=7d (or ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD) and ?tab=insights|comments|x pick the view,
// so a shared link opens the same period and tab. Default: the last 30 days, Overview.
export default async function Home({ searchParams }: { searchParams: Promise<Params> }) {
  const [jar, params] = await Promise.all([cookies(), searchParams]);
  const signedIn = await isSignedIn(jar.get(AUTH_COOKIE)?.value);
  const publicMode = isPublicDashboard();
  const range = rangeFromParams(params, istToday(), "30d");
  const tab: Tab =
    params.tab === "insights" || (ORM_ENABLED && (params.tab === "comments" || params.tab === "x")) ? params.tab : "overview";
  // Commenter names and contact details are only sent to signed-in viewers.
  // Sync warnings are for the team only.
  const data = await loadDashboard({
    publicView: publicMode && !signedIn,
    warnings: signedIn,
    since: loadSince(range),
  });
  return <Dashboard data={data} signedIn={signedIn} publicMode={publicMode} initialRange={range} initialTab={tab} />;
}
