import { redirect } from "next/navigation";

type Params = { range?: string; from?: string; to?: string };

// /insights is the dashboard's Insights tab, for the Overview's "See more" links and shared links.
export default async function InsightsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const q = new URLSearchParams({ tab: "insights" });
  for (const k of ["range", "from", "to"] as const) if (params[k]) q.set(k, params[k]!);
  redirect(`/?${q.toString()}`);
}
