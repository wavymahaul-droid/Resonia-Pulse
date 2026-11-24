// Talking Points (/talking-points): a weekly view from data already stored (no Apify, no AI): the
// competitors' best posts of the week and why they did well, themes they covered that Resonia didn't,
// and the week's High-relevance Radar items, plus a plain-text brief to paste into an AI assistant.
import type { DashBrand, DashPost } from "@/lib/dashboard";
import { formatOf } from "@/lib/insights";
import { fmtInt, istDay, postsInRange } from "@/lib/metrics";
import type { RadarItem } from "@/lib/radar";
import { shiftDay, type DateRange } from "@/lib/range";

export const BRIEF_INSTRUCTION =
  "Suggest 5 LinkedIn post ideas for Resonia (page, angle, hook, Resonia proof point, source link). No em-dashes.";

const eng = (p: DashPost) => p.likes + p.comments;
const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export type CompPost = { post: DashPost; brand: DashBrand; value: number; pageAvg: number; multiple: number };
export type ThemeGap = { theme: string; posts: number; pages: string[]; example: CompPost };
export type Weekly = { week: DateRange; label: string; top: CompPost[]; gaps: ThemeGap[]; radar: RadarItem[] };

// The 7 days to `to` (IST).
export const weekTo = (to: string): DateRange => ({ key: "custom", from: shiftDay(to, -6), to });

export function weekly(
  { posts, brands, radar, to }: { posts: DashPost[]; brands: DashBrand[]; radar: RadarItem[]; to: string },
  n = 5,
): Weekly {
  const week = weekTo(to);
  // A page's usual likes + comments: the average over all loaded posts (needs 3+).
  const avg = new Map<string, number>();
  for (const b of brands) {
    const own = posts.filter((p) => p.brand === b.id);
    if (own.length >= 3) avg.set(b.id, own.reduce((a, p) => a + eng(p), 0) / own.length);
  }
  const inWeek = postsInRange(posts, week);
  const comp = inWeek.flatMap((p) => {
    const brand = brands.find((b) => b.id === p.brand && !b.is_montra);
    const a = brand ? avg.get(brand.id) : undefined;
    return brand && a ? [{ post: p, brand, value: eng(p), pageAvg: a, multiple: eng(p) / a }] : [];
  });
  const top = [...comp].sort((a, b) => b.multiple - a.multiple || b.value - a.value).slice(0, n);

  // Themes competitors posted about this week and Resonia did not ("Other" is not a theme).
  const montraThemes = new Set(
    inWeek.filter((p) => brands.some((b) => b.id === p.brand && b.is_montra)).map((p) => p.theme),
  );
  const byTheme = new Map<string, CompPost[]>();
  for (const c of comp)
    if (!montraThemes.has(c.post.theme) && c.post.theme !== "Other")
      byTheme.set(c.post.theme, [...(byTheme.get(c.post.theme) ?? []), c]);
  const gaps = [...byTheme]
    .map(([theme, list]) => ({
      theme,
      posts: list.length,
      pages: [...new Set(list.map((c) => c.brand.name))],
      example: [...list].sort((a, b) => b.multiple - a.multiple)[0],
    }))
    .sort((a, b) => b.posts - a.posts || b.example.multiple - a.example.multiple);

  const high = radar
    .filter(
      (r) =>
        r.relevance === "High" &&
        r.published_at &&
        istDay(r.published_at) >= week.from &&
        istDay(r.published_at) <= week.to,
    )
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));

  return { week, label: `${fmtDay(week.from)} to ${fmtDay(week.to)}`, top, gaps, radar: high };
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}...` : one;
};
// The brief asks for no em-dashes, so none are passed on from post text or headlines either.
const noDash = (s: string) => s.replace(/\s*[—–]\s*/g, " - ");

export type BriefVideo = { page: string; postedAt: string; language: string | null; summary: string; url: string };

export function weeklyBrief(
  w: Weekly,
  { notes = false, videos }: { notes?: boolean; videos?: BriefVideo[] } = {},
): string {
  const L = [BRIEF_INSTRUCTION, "", `WEEKLY BRIEF, ${w.label}`];
  L.push("", "TOP COMPETITOR POSTS THIS WEEK (likes + comments vs the page's usual)");
  if (!w.top.length) L.push("- None this week");
  w.top.forEach((c, i) =>
    L.push(
      `${i + 1}. ${c.brand.name}, ${fmtDay(istDay(c.post.posted_at))}, theme: ${c.post.theme}, format: ${formatOf(c.post.media)}`,
      `   "${clip(c.post.text || "(no text)", 160)}"`,
      `   ${fmtInt(c.value)} likes + comments, ${c.multiple.toFixed(1)}x the page average (${fmtInt(Math.round(c.pageAvg))})`,
      `   ${c.post.url}`,
    ),
  );
  L.push("", "THEMES COMPETITORS COVERED THAT MONTRA DIDN'T");
  if (!w.gaps.length) L.push("- None: Resonia covered every theme the competitors posted about");
  for (const g of w.gaps)
    L.push(
      `- ${g.theme}: ${g.posts} competitor ${g.posts === 1 ? "post" : "posts"} (${g.pages.join(", ")}). Best: ${g.example.brand.name}, ${g.example.multiple.toFixed(1)}x page average, ${g.example.post.url}`,
    );
  // What competitors said in their videos this week (automatic transcripts; signed-in viewers only).
  if (videos) {
    L.push("", "COMPETITOR VIDEOS THIS WEEK (what they say and show, from automatic transcripts)");
    if (!videos.length) L.push("- None this week");
    for (const v of videos.slice(0, 12))
      L.push(
        `- ${v.page}, ${fmtDay(istDay(v.postedAt))}${v.language && !/^(none|unknown)$/i.test(v.language) ? `, spoken in ${v.language}` : ""}: ${clip(v.summary, 320)} ${v.url}`,
      );
  }
  L.push("", "INDUSTRY RADAR, HIGH RELEVANCE");
  if (!w.radar.length) L.push("- None this week");
  for (const r of w.radar) {
    L.push(
      `- ${r.title} (${r.source ?? "source unknown"}, ${r.published_at ? fmtDay(istDay(r.published_at)) : "undated"}). ${r.type}; ${r.pages.join(", ")}. ${r.url}`,
    );
    if (notes && r.note) L.push(`  Why it matters: ${r.note}`);
  }
  return noDash(L.join("\n"));
}
