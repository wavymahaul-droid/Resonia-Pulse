// Industry Radar (/radar): headlines from free RSS feeds (Google News searches, PIB, trade media),
// tagged by simple keyword rules from radar.json. Pure, safe in the browser. Only the headline, link,
// source, date and the feed's short snippet are kept; never article text.
import config from "@/radar.json";
import brandsJson from "@/brands.json";
import { clip } from "@/lib/sanitise";

export type RadarConfig = typeof config;
export const RADAR = config;

export type RadarType = "Policy" | "Market data" | "Competitor" | "Charging & infra" | "Customer sectors";
export const RADAR_TYPES: RadarType[] = ["Policy", "Market data", "Competitor", "Charging & infra", "Customer sectors"];
export type RadarPage = "Truck" | "SCV & 3W" | "Tractor" | "Corporate";
export const RADAR_PAGES: RadarPage[] = ["Truck", "SCV & 3W", "Tractor", "Corporate"];
export type Relevance = "High" | "Medium";

export const SNIPPET_MAX = 280;

// A feed to read: a Google News search, or a fixed RSS feed.
export type Feed = { name: string; url: string; query: string; filter: boolean };

const COMPETITORS = (brandsJson as { name: string; is_montra: boolean }[])
  .filter((b) => !b.is_montra)
  .map((b) => b.name);

export const googleNewsUrl = (q: string) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;

// Every feed from radar.json: the searches, one "<competitor> electric" search per competitor, and the
// fixed feeds.
export function radarFeeds(cfg: RadarConfig = config): Feed[] {
  const queries = [...cfg.googleNewsQueries, ...COMPETITORS.map((c) => `${c} electric`)];
  return [
    ...queries.map((q) => ({ name: `Google News: ${q}`, url: googleNewsUrl(q), query: q, filter: false })),
    ...cfg.feeds.map((f) => ({ name: f.name, url: f.url, query: f.name, filter: !!f.filter })),
  ];
}

// ---------- RSS ----------

export type RssItem = {
  title: string;
  url: string;
  source: string | null;
  snippet: string | null;
  publishedAt: string | null;
};

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");
const stripTags = (s: string) =>
  decode(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
};

// RSS 2.0 <item>s or Atom <entry>s. Google News titles end in " - Publisher"; that goes to source.
export function parseRss(xml: string, fallbackSource: string): RssItem[] {
  const blocks = [
    ...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);
  const out: RssItem[] = [];
  for (const b of blocks) {
    let title = stripTags(tag(b, "title") ?? "");
    const link =
      stripTags(tag(b, "link") ?? "") ||
      (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? "") ||
      stripTags(tag(b, "guid") ?? "");
    if (!title || !/^https?:\/\//.test(link)) continue;
    let source = stripTags(tag(b, "source") ?? "") || null;
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const raw = tag(b, "description") ?? tag(b, "summary");
    let snippet = raw ? stripTags(raw) : null;
    // Google News descriptions repeat the headline and publisher; keep a snippet only when it adds something.
    if (snippet && (snippet.startsWith(title) || snippet.length < 20)) snippet = null;
    if (snippet) snippet = clip(snippet, SNIPPET_MAX, true);
    const date = stripTags(tag(b, "pubDate") ?? tag(b, "published") ?? tag(b, "updated") ?? tag(b, "dc:date") ?? "");
    const t = date ? Date.parse(date) : NaN;
    out.push({
      title,
      url: link,
      source: source ?? fallbackSource,
      snippet,
      publishedAt: Number.isNaN(t) ? null : new Date(t).toISOString(),
    });
  }
  return out;
}

// ---------- dedupe ----------

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);

// A key for exact-ish duplicates: the title's words, in order.
export const titleKey = (title: string) => words(title).join(" ").slice(0, 120);

// Near-identical titles: the same key, or 80%+ of their words shared.
export function similarTitles(a: string, b: string): boolean {
  if (titleKey(a) === titleKey(b)) return true;
  const wa = new Set(words(a));
  const wb = new Set(words(b));
  if (wa.size < 4 || wb.size < 4) return false;
  const shared = [...wa].filter((w) => wb.has(w)).length;
  return shared / Math.min(wa.size, wb.size) >= 0.8 && shared / Math.max(wa.size, wb.size) >= 0.6;
}

// Feed-level keyword filter for broad feeds (PIB, trade media).
export function mentionsFilter(text: string, cfg: RadarConfig = config): boolean {
  return cfg.filterKeywords.some((k) => hasWord(text, k));
}

// ---------- tags ----------

// Whole-word match, case-insensitive (short tokens like "EV" or "3W" must not match inside words);
// plurals count ("truck" matches "trucks"), and a stem like "agricultur" matches the start of a word.
export function hasWord(text: string, keyword: string): boolean {
  const k = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stem = /[a-z]$/i.test(keyword) && keyword.length > 6 && !keyword.includes(" ") && !/[aeiouy]$/i.test(keyword);
  const end = stem ? "" : "(?:s|es)?(?![a-z0-9])";
  return new RegExp(`(?<![a-z0-9])${k}${end}`, "i").test(text);
}

export type RadarTags = {
  type: RadarType;
  relevance: Relevance;
  pages: RadarPage[];
  competitor: string | null;
  excluded: boolean; // a passenger car, two-wheeler or luxury EV story: not shown or stored
  why: string | null; // the High rule that matched
};

type HighRule = { label: string; pages: string[]; allOf: string[][] };

// Passenger cars, two-wheelers and luxury EVs, unless Resonia, a tracked competitor or a commercial
// vehicle word is named too.
export function isExcluded(text: string, competitor: string | null, cfg: RadarConfig = config): boolean {
  if (cfg.exclude.alwaysKeywords.some((k) => hasWord(text, k))) return true;
  if (!cfg.exclude.keywords.some((k) => hasWord(text, k))) return false;
  return !(competitor || cfg.exclude.unlessKeywords.some((k) => hasWord(text, k)));
}

export function tagItem(
  item: { title: string; snippet?: string | null; query?: string | null },
  cfg: RadarConfig = config,
): RadarTags {
  const text = `${item.title} ${item.snippet ?? ""}`;
  const competitor = COMPETITORS.find((c) => hasWord(text, c) || hasWord(text, c.split(" ")[0])) ?? null;
  const types = cfg.types as Record<Exclude<RadarType, "Competitor">, string[]>;
  const ruled = (Object.keys(types) as Exclude<RadarType, "Competitor">[]).find((t) =>
    types[t].some((k) => hasWord(text, k)),
  );
  const type: RadarType = ruled === "Policy" ? "Policy" : competitor ? "Competitor" : (ruled ?? "Market data");
  // High when every keyword group of a rule matches; the rule's pages are added.
  const high = (cfg.highRules as HighRule[]).filter((r) =>
    r.allOf.every((group) => group.some((k) => hasWord(text, k))),
  );
  const pageRules = cfg.pages as Record<RadarPage, string[]>;
  const pages = RADAR_PAGES.filter(
    (p) => pageRules[p].some((k) => hasWord(text, k)) || high.some((r) => r.pages.includes(p)),
  );
  return {
    type,
    relevance: high.length ? "High" : "Medium",
    pages: pages.length ? pages : ["Corporate"],
    competitor,
    excluded: isExcluded(text, competitor, cfg),
    why: high.map((r) => r.label).join("; ") || null,
  };
}

// A stored Radar item as the pages see it.
export type RadarItem = {
  url: string;
  title: string;
  source: string | null;
  snippet: string | null;
  published_at: string | null;
  query: string | null;
  note?: string | null; // "Why it matters" (signed-in only)
} & RadarTags;

// Tagged items, with passenger car, two-wheeler and luxury EV stories left out.
export function withTags(rows: Omit<RadarItem, keyof RadarTags>[]): RadarItem[] {
  return rows.map((r) => ({ ...r, ...tagItem(r) })).filter((r) => !r.excluded);
}
