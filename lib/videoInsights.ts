// Video insights: which videos the daily run picks, and how the dashboard reads the results
// (mentions of Resonia, regional languages, alerts, the weekly brief). Pure, safe in the browser.
import type { VideoCandidate } from "@/lib/videoPilot";

// "page" of a saved video: a brands.json id (a page we track), "x:MontraElectric" (our X account),
// or "mention:linkedin" / "mention:x" (someone else's video post that mentions Resonia).
export type VideoKind = "competitor" | "montra" | "mention";
export const videoKind = (page: string, montraIds: ReadonlySet<string>): VideoKind =>
  page.startsWith("mention:") ? "mention" : page.startsWith("x:") || montraIds.has(page) ? "montra" : "competitor";

// ---------- the daily pick ----------

export const DAILY_HOURS = 48;
export const DAILY_CAP = 10;
export const MAX_SECONDS = 5 * 60;

// New videos from the last 48 hours with no transcript yet, at most 10: videos that mention Resonia
// first (the ones an alert may depend on), then competitors', then Resonia's own; newest first
// within each group. The same post is never picked twice.
export function selectDaily(
  all: VideoCandidate[],
  done: ReadonlySet<string>, // post ids that already have a transcript
  { now = new Date(), hours = DAILY_HOURS, cap = DAILY_CAP }: { now?: Date; hours?: number; cap?: number } = {},
): VideoCandidate[] {
  const since = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const rank = (c: VideoCandidate) => (c.mention ? 0 : c.montra ? 2 : 1);
  const seen = new Set<string>();
  return all
    .filter((c) => c.postedAt >= since && c.postedAt <= now.toISOString() && !done.has(c.postId))
    .sort((a, b) => rank(a) - rank(b) || b.postedAt.localeCompare(a.postedAt))
    .filter((c) => (seen.has(c.postId) ? false : (seen.add(c.postId), true)))
    .slice(0, cap);
}

// ---------- reading the results ----------

export type VideoLike = {
  postUrl: string;
  page: string;
  postedAt: string | null;
  language: string | null;
  summary: string | null;
  transcriptOriginal: string | null;
  transcriptEnglish: string | null;
  onScreenText: string | null;
  brands: string[];
  tone: string | null;
};

// Resonia, or one of its products, by name.
export const MONTRA_WORDS = /\bmontra\b|\beviator\b|\brhino\b|\bsuper\s?auto\b|मोंट्रा|மோன்ட்ரா/i;

// True when the video names Resonia or a Resonia product: in what is said, shown on screen, the
// summary or the brands Gemini listed. A video found through a mention search always does.
export function mentionsMontra(v: VideoLike): boolean {
  if (v.page.startsWith("mention:")) return true;
  return [v.summary, v.transcriptOriginal, v.transcriptEnglish, v.onScreenText, ...v.brands].some(
    (t) => !!t && MONTRA_WORDS.test(t),
  );
}

// Spoken in an Indian language other than English (Hinglish counts).
export function isRegional(language: string | null): boolean {
  if (!language) return false;
  return !/^(english|none|unknown|n\/a|no speech|instrumental|music)?$/i.test(language.trim());
}

const istDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(iso));
const fmtDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const sourceName = (page: string, pageName: (id: string) => string) =>
  page === "mention:linkedin" ? "a LinkedIn post" : page === "mention:x" ? "an X post" : pageName(page);

export type VideoAlert = { text: string; href: string; kind: "negative" | "competitor" };

// Alerts for the last `days` days: a video that mentions Resonia with a negative tone (anyone's but
// our own), and a competitor's video that mentions Resonia or a Resonia product.
export function videoAlerts(
  items: VideoLike[],
  {
    montraIds,
    pageName,
    today,
    days = 7,
  }: { montraIds: ReadonlySet<string>; pageName: (id: string) => string; today: string; days?: number },
): VideoAlert[] {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const recent = items
    .filter((v) => v.postedAt && istDay(v.postedAt) >= from && istDay(v.postedAt) <= today)
    .filter((v) => videoKind(v.page, montraIds) !== "montra" && mentionsMontra(v))
    .sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
  const label = (v: VideoLike) => `${sourceName(v.page, pageName)}, ${fmtDay(istDay(v.postedAt!))}`;
  const more = (n: number) => (n > 1 ? ` (and ${n - 1} more)` : "");
  const out: VideoAlert[] = [];
  const negative = recent.filter((v) => v.tone === "negative");
  if (negative.length)
    out.push({
      kind: "negative",
      text: `Negative video mentioning Resonia: ${label(negative[0])}${more(negative.length)}`,
      href: negative[0].postUrl,
    });
  const competitor = recent.filter((v) => videoKind(v.page, montraIds) === "competitor" && v.tone !== "negative");
  if (competitor.length)
    out.push({
      kind: "competitor",
      text: `Competitor video mentions Resonia: ${label(competitor[0])}${more(competitor.length)}`,
      href: competitor[0].postUrl,
    });
  return out;
}

// Competitor videos posted in a week (IST days, both included), newest first, for the weekly brief.
export function weekCompetitorVideos<V extends VideoLike>(
  items: V[],
  montraIds: ReadonlySet<string>,
  week: { from: string; to: string },
): V[] {
  return items
    .filter((v) => videoKind(v.page, montraIds) === "competitor" && v.summary && v.postedAt)
    .filter((v) => istDay(v.postedAt!) >= week.from && istDay(v.postedAt!) <= week.to)
    .sort((a, b) => (b.postedAt ?? "").localeCompare(a.postedAt ?? ""));
}
