// Reads the exports from a LinkedIn page's analytics (Content, Followers and Visitors; .xls,
// .xlsx or .csv). LinkedIn puts a line of description above the column names and names sheets
// and columns slightly differently over time, so sheets are recognised by their columns, not
// their names. Pure: no database. Used by app/api/linkedin-upload.
import * as XLSX from "@e965/xlsx";

export type PostMetricRow = {
  link: string; // "Post link" as exported
  ids: string[]; // every 19-digit LinkedIn id in the link (activity, share or ugcPost)
  title: string; // the start of the post text
  created: string | null; // YYYY-MM-DD
  impressions: number | null;
  clicks: number | null;
  ctr: number | null; // 0.0123 = 1.23%
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  engagementRate: number | null;
  contentType: string | null; // "Image", "Video", "Document", "Text", "Article"... as exported
  postType: string | null; // "Organic" / "Sponsored" as exported
  // The export marks it as paid (post type or a campaign name). Resonia's campaigns run as dark
  // posts (Direct Sponsored Content) that never appear on the feed, so a post that is on a
  // Resonia feed is organic whatever this says; see isAdRow.
  sponsored: boolean;
  raw: Record<string, string | number | boolean | null>; // the export row, by column name
};

export type DailyRow = { date: string } & Partial<Record<DailyField, number | null>>;
export type DailyField =
  | "impressions"
  | "unique_impressions"
  | "clicks"
  | "reactions"
  | "comments"
  | "reposts"
  | "engagement_rate"
  | "impressions_organic"
  | "impressions_sponsored"
  | "clicks_organic"
  | "clicks_sponsored"
  | "reactions_organic"
  | "reactions_sponsored"
  | "comments_organic"
  | "comments_sponsored"
  | "reposts_organic"
  | "reposts_sponsored"
  | "new_followers_organic"
  | "new_followers_sponsored"
  | "new_followers"
  | "page_views"
  | "unique_visitors";

export type ParsedExport = {
  kinds: ("content" | "followers" | "visitors")[];
  posts: PostMetricRow[];
  daily: DailyRow[]; // one row per date, the fields this file has
  dateFrom: string | null;
  dateTo: string | null;
  warnings: string[];
};

type Cell = string | number | boolean | Date | null | undefined;
const norm = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// ---------- values ----------

export function toNumber(v: Cell): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v instanceof Date) return null;
  const s = v.replace(/[,\s]/g, "").replace(/%$/, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return v.trim().endsWith("%") ? n / 100 : n;
}

// A rate (CTR, engagement rate): "1.23%" -> 0.0123; 0.0123 stays; 1.23 (a bare percentage) -> 0.0123.
export function toRate(v: Cell): number | null {
  const n = toNumber(v);
  if (n == null) return null;
  return typeof v === "string" && v.trim().endsWith("%") ? n : n > 1 ? n / 100 : n;
}

const pad = (n: number) => String(n).padStart(2, "0");

// Dates as LinkedIn writes them (MM/DD/YYYY), ISO dates, Excel serial numbers or Date cells.
// `dayFirst` reads 05/10/2026 as 5 Oct (set when the file has a date like 25/10/2026).
export function toDate(v: Cell, dayFirst = false): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? null : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  if (typeof v === "number") {
    if (v < 20_000 || v > 80_000) return null; // not an Excel date serial
    const d = XLSX.SSF.parse_date_code(v);
    return d ? `${d.y}-${pad(d.m)}-${pad(d.d)}` : null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    const [mo, d] = dayFirst || a > 12 ? [b, a] : [a, b];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return `${m[3]}-${pad(mo)}-${pad(d)}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t) && /[a-z]/i.test(s)) {
    const d = new Date(t);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  return null;
}

// ---------- columns ----------

// For each field, the column names LinkedIn uses (normalised), best first. "(total)" columns are
// preferred over organic-only ones so sponsored reach is counted when a page boosts a post.
const POST_COLS: Record<keyof Omit<PostMetricRow, "ids" | "sponsored" | "raw">, string[]> = {
  link: ["post link", "post url", "link", "url"],
  title: ["post title", "update title", "title", "post text", "commentary"],
  created: ["created date", "date posted", "posted date", "date"],
  impressions: ["impressions", "impressions total", "impressions organic"],
  clicks: ["clicks", "clicks total", "clicks organic"],
  ctr: ["click through rate ctr", "click through rate", "ctr"],
  reactions: ["likes", "reactions", "reactions total", "reactions organic"],
  comments: ["comments", "comments total", "comments organic"],
  reposts: ["reposts", "shares", "reposts total", "shares total"],
  engagementRate: ["engagement rate", "engagement rate total", "engagement rate organic"],
  contentType: ["content type", "post content type", "media type"],
  postType: ["post type", "type"],
};
const CAMPAIGN_COLS = ["campaign name", "campaign"];

const DAILY_COLS: Record<DailyField, string[]> = {
  impressions: ["impressions total", "impressions"],
  unique_impressions: ["unique impressions organic", "unique impressions"],
  clicks: ["clicks total", "clicks"],
  reactions: ["reactions total", "reactions"],
  comments: ["comments total", "comments"],
  reposts: ["reposts total", "shares total", "reposts", "shares"],
  engagement_rate: ["engagement rate total", "engagement rate"],
  impressions_organic: ["impressions organic"],
  impressions_sponsored: ["impressions sponsored"],
  clicks_organic: ["clicks organic"],
  clicks_sponsored: ["clicks sponsored"],
  reactions_organic: ["reactions organic", "likes organic"],
  reactions_sponsored: ["reactions sponsored", "likes sponsored"],
  comments_organic: ["comments organic"],
  comments_sponsored: ["comments sponsored"],
  reposts_organic: ["reposts organic", "shares organic"],
  reposts_sponsored: ["reposts sponsored", "shares sponsored"],
  new_followers_organic: ["organic followers", "new followers organic"],
  new_followers_sponsored: ["sponsored followers", "new followers sponsored"],
  new_followers: ["total followers", "new followers total", "new followers"],
  page_views: ["total page views total", "page views total", "total page views"],
  unique_visitors: ["total unique visitors total", "unique visitors total", "total unique visitors"],
};
const RATE_FIELDS = new Set<DailyField>(["engagement_rate"]);

function pick(header: string[], names: string[]): number {
  for (const n of names) {
    const i = header.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

// The header row: the first of the top 12 rows with a date column (daily sheets) or a post link
// column (the posts sheet).
function findHeader(rows: Cell[][]): { at: number; header: string[] } | null {
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const header = rows[i].map(norm);
    if (pick(header, POST_COLS.link) >= 0 && pick(header, POST_COLS.impressions) >= 0) return { at: i, header };
    if (header[0] === "date" || (header.includes("date") && header.filter(Boolean).length >= 2))
      return { at: i, header };
  }
  return null;
}

// The export marks a row as paid: a sponsored post type or a campaign name. Numbers are never used
// to guess (video plays and document page clicks count as clicks, so CTR above 100% is normal).
export function isSponsored(r: { postType: string | null; campaign?: string | null }): boolean {
  if (r.postType && /sponsor|paid|boost|promot|\bad\b/i.test(r.postType)) return true;
  return !!r.campaign?.trim();
}

// A link to a post on a page's feed (as opposed to a dark post or a Campaign Manager link).
export function hasFeedUrl(link: string | null | undefined): boolean {
  return /linkedin\.com\/(?:feed\/update\/urn:li:(?:activity|share|ugcPost):\d+|posts\/)/i.test(link ?? "");
}

// An export row that matched no feed post is an ad (not on the feed) when the export marks it as
// sponsored or its link is not a feed post link.
export function isAdRow(r: { link: string; sponsored: boolean }): boolean {
  return r.sponsored || !hasFeedUrl(r.link);
}

// The export's "Content Type" says video (LinkedIn counts video plays as clicks).
export const isVideoType = (contentType: unknown) => /video/i.test(String(contentType ?? ""));

// ---------- workbook ----------

export function parseExport(buf: ArrayBuffer | Buffer, fileName = ""): ParsedExport {
  // raw: CSV text stays text, so dates are read here (US or day-first), not guessed by the parser.
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true, raw: true, dense: true });
  const out: ParsedExport = { kinds: [], posts: [], daily: [], dateFrom: null, dateTo: null, warnings: [] };
  const byDate = new Map<string, DailyRow>();
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json<Cell[]>(wb.Sheets[name], {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });
    const found = findHeader(rows);
    if (!found) continue;
    const { at, header } = found;
    const body = rows.slice(at + 1).filter((r) => r.some((c) => c != null && c !== ""));

    // Posts sheet ("All posts").
    const linkCol = pick(header, POST_COLS.link);
    if (linkCol >= 0 && pick(header, POST_COLS.impressions) >= 0) {
      const cols = Object.fromEntries(
        Object.entries(POST_COLS).map(([k, names]) => [k, pick(header, names)]),
      ) as Record<keyof typeof POST_COLS, number>;
      const dayFirst = body.some((r) =>
        /^(1[3-9]|2\d|3[01])[/.-]\d{1,2}[/.-]\d{4}/.test(String(r[cols.created] ?? "")),
      );
      for (const r of body) {
        const link = String(r[linkCol] ?? "").trim();
        if (!/linkedin\.com|urn:li:/i.test(link)) continue;
        const get = (k: keyof typeof POST_COLS) => (cols[k] >= 0 ? r[cols[k]] : null);
        const impressions = toNumber(get("impressions"));
        const clicks = toNumber(get("clicks"));
        const exportedCtr = toRate(get("ctr"));
        const postType = String(get("postType") ?? "").trim() || null;
        const campaignCol = pick(header, CAMPAIGN_COLS);
        const campaign = campaignCol >= 0 ? String(r[campaignCol] ?? "").trim() : "";
        const raw: PostMetricRow["raw"] = {};
        rows[at].forEach((h, i) => {
          if (h == null || h === "") return;
          const v = r[i];
          raw[String(h)] = v instanceof Date ? v.toISOString().slice(0, 10) : (v ?? null);
        });
        out.posts.push({
          link,
          ids: [...link.matchAll(/\d{16,20}/g)].map((m) => m[0]),
          title: String(get("title") ?? "").trim(),
          created: toDate(get("created"), dayFirst),
          impressions,
          clicks,
          ctr: exportedCtr ?? (impressions && clicks != null ? clicks / impressions : null),
          reactions: toNumber(get("reactions")),
          comments: toNumber(get("comments")),
          reposts: toNumber(get("reposts")),
          engagementRate: toRate(get("engagementRate")),
          contentType: String(get("contentType") ?? "").trim() || null,
          postType,
          sponsored: isSponsored({ postType, campaign }),
          raw,
        });
      }
      if (!out.kinds.includes("content")) out.kinds.push("content");
      continue;
    }

    // Daily sheets: content metrics, new followers or visitor metrics.
    const dateCol = header.indexOf("date");
    if (dateCol < 0) continue;
    const fields = (Object.keys(DAILY_COLS) as DailyField[])
      .map((f) => ({ f, i: pick(header, DAILY_COLS[f]) }))
      .filter((x) => x.i >= 0);
    // Only the totals sheets; the demographic sheets (location, industry...) have no date column.
    if (!fields.length) continue;
    const kind = fields.some((x) => x.f.startsWith("new_followers"))
      ? "followers"
      : fields.some((x) => x.f === "page_views" || x.f === "unique_visitors")
        ? "visitors"
        : "content";
    // A followers sheet's "total followers" column is the day's new followers, not the page total.
    const use = fields.filter((x) =>
      kind === "followers" ? x.f.startsWith("new_followers") : kind === "visitors" ? !x.f.startsWith("new_") : true,
    );
    const dayFirst = body.some((r) => /^(1[3-9]|2\d|3[01])[/.-]\d{1,2}[/.-]\d{4}/.test(String(r[dateCol] ?? "")));
    let n = 0;
    for (const r of body) {
      const date = toDate(r[dateCol], dayFirst);
      if (!date) continue;
      const row = byDate.get(date) ?? { date };
      for (const { f, i } of use) row[f] = RATE_FIELDS.has(f) ? toRate(r[i]) : toNumber(r[i]);
      byDate.set(date, row);
      n++;
    }
    if (n && !out.kinds.includes(kind)) out.kinds.push(kind);
  }
  out.daily = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const dates = [
    ...out.daily.map((d) => d.date),
    ...out.posts.map((p) => p.created).filter((d): d is string => !!d),
  ].sort();
  out.dateFrom = dates[0] ?? null;
  out.dateTo = dates.at(-1) ?? null;
  if (!out.kinds.length)
    out.warnings.push(
      `${fileName || "This file"} does not look like a LinkedIn page analytics export (no "Date" or "Post link" columns found).`,
    );
  return out;
}

// ---------- matching posts ----------

export type StoredPost = {
  post_url: string;
  brand_id: string;
  linkedin_id: string | null;
  posted_at: string | null;
  text: string | null;
  origin?: string; // "sync" (default), "export" or "backfill"
};

const textKey = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .slice(0, 40);

const istDay = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

// The stored post an export row is about: the same LinkedIn id in the link (activity id), or else
// the same opening text posted within a day of the export's created date. Exports sometimes link
// a post by its share or ugcPost id, which differs from the activity id the tracker stores.
export function matchPost(row: PostMetricRow, posts: StoredPost[]): StoredPost | null {
  // An export link seen before is the same record (it may be a post created from an export).
  const byId = posts.find((p) => p.linkedin_id && row.ids.includes(p.linkedin_id));
  if (byId) return byId;
  const viaUrl = posts.find((p) => p.post_url === row.link);
  if (viaUrl) return viaUrl;
  const key = textKey(row.title);
  if (key.length < 12) return null;
  const candidates = posts.filter((p) => {
    const k = textKey(p.text);
    if (!k || !(k.startsWith(key) || key.startsWith(k))) return false;
    return !row.created || !p.posted_at || dayDiff(row.created, istDay(p.posted_at)) <= 1;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

// The Resonia page a file is for, from its file name (LinkedIn names exports after the page,
// e.g. "montra-electric-scv_content_1728000000000.xls").
export function pageFromFileName(fileName: string, pages: { id: string; name: string }[]): string | null {
  const f = norm(fileName).replace(/\s+/g, "");
  const hits = pages.filter(
    (p) => f.includes(p.id.replace(/[^a-z0-9]/gi, "").toLowerCase()) || f.includes(norm(p.name).replace(/\s+/g, "")),
  );
  // "montraelectricscv" also contains "montraelectric": the longest match wins.
  hits.sort((a, b) => b.id.length - a.id.length);
  return hits[0]?.id ?? null;
}

// The tracker's media type for an export's "Content Type" (posts created from an export).
export function exportMediaType(contentType: string | null | undefined): string {
  const t = norm(contentType);
  if (/video/.test(t)) return "video";
  if (/document|pdf|carousel/.test(t)) return "document";
  if (/image|photo|picture/.test(t)) return "image";
  if (/article|link/.test(t)) return "article";
  return "text";
}

// Whether two post records on the same page are the same LinkedIn post: the same LinkedIn id,
// or the same opening text posted within a day. Used to fold a post created from an export into
// the one the daily sync finds later.
export function samePost(
  a: Pick<StoredPost, "brand_id" | "linkedin_id" | "posted_at" | "text">,
  b: Pick<StoredPost, "brand_id" | "linkedin_id" | "posted_at" | "text">,
): boolean {
  if (a.brand_id !== b.brand_id) return false;
  if (a.linkedin_id && a.linkedin_id === b.linkedin_id) return true;
  const [ka, kb] = [textKey(a.text), textKey(b.text)];
  if (Math.min(ka.length, kb.length) < 12 || !(ka.startsWith(kb) || kb.startsWith(ka))) return false;
  return !a.posted_at || !b.posted_at || dayDiff(istDay(a.posted_at), istDay(b.posted_at)) <= 1;
}
