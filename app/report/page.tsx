import { cookies } from "next/headers";
import Report from "@/app/Report";
import { previousRange } from "@/lib/analytics";
import { AUTH_COOKIE, isPublicDashboard, isSignedIn } from "@/lib/auth";
import { loadDashboard, loadMonthly } from "@/lib/dashboard";
import { defaultMonth, isMonth, shiftMonth } from "@/lib/monthly";
import { istToday, loadSince, rangeFromParams } from "@/lib/range";

export const dynamic = "force-dynamic";
export const metadata = { title: "Report · Resonia Pulse" };

type Params = { range?: string; from?: string; to?: string; month?: string };

// Client-ready summary for any range (?range=30d, or ?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD;
// default: the last 30 days), compared with the previous period of equal length, plus the monthly
// client report for ?month=YYYY-MM (default: last month). Stored data only.
export default async function ReportPage({ searchParams }: { searchParams: Promise<Params> }) {
  const [jar, params] = await Promise.all([cookies(), searchParams]);
  const signedIn = await isSignedIn(jar.get(AUTH_COOKIE)?.value);
  const range = rangeFromParams(params, istToday(), "30d");
  const month = isMonth(params.month) ? params.month : defaultMonth(istToday());
  // The previous period is loaded too, and the monthly report's three months. Same masking as the
  // dashboard.
  const rangeSince = loadSince(previousRange(range));
  const monthSince = new Date(`${shiftMonth(month, -2)}-01T00:00:00+05:30`).toISOString();
  const [data, monthly] = await Promise.all([
    loadDashboard({
      publicView: isPublicDashboard() && !signedIn,
      since: monthSince < rangeSince ? monthSince : rangeSince,
    }),
    loadMonthly(),
  ]);
  return <Report data={data} initialRange={range} month={month} monthly={monthly} signedIn={signedIn} />;
}
