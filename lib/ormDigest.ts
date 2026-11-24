// The ORM agent's digest (GET /api/orm-digest): sync health, Resonia's new posts, comments needing a
// response, mentions, competitor posts and notable signals over the last N hours. Pure: the route
// loads the data with the dashboard's own queries and passes it in. Read-only; no Apify calls.
import type { DashBrand, DashComment, DashPost } from "@/lib/dashboard";
import { isOpen } from "@/lib/orm";
import { runReason } from "@/lib/runs";
import { STANDOUT_MULTIPLE } from "@/lib/overview";

export const DEFAULT_HOURS = 24;
export const MAX_HOURS = 168;
// Negative comments are a spike when there are at least this many in the window and at least
// SPIKE_MULTIPLE times the usual number per window over the 7 days before.
export const SPIKE_MIN = 2;
export const SPIKE_MULTIPLE = 2;
export const BASELINE_DAYS = 7;

export type DigestRun = {
  kind?: string | null;
  started_at: string;
  finished_at: string | null;
  status: string;
  notes: string | null;
};

export type OrmDigestInput = {
  now: Date;
  hours: number;
  brands: (DashBrand & { last_synced_at: string | null })[];
  posts: DashPost[]; // feed posts (no ads), the last 90 days, for averages
  comments: DashComment[]; // LinkedIn comments, from BASELINE_DAYS + the window back
  mentions: DashComment[]; // LinkedIn mentions and X mentions (by other accounts), from the window start
  runs: DigestRun[]; // newest first
};

export type Flag = "negative" | "complaint" | "question" | "sales query" | "job query";

const FLAGS: Record<string, Flag> = {
  Negative: "negative",
  Question: "question",
  Lead: "sales query",
  Careers: "job query",
};
// A negative comment that names a problem is also a complaint.
const COMPLAINT =
  /\b(complain\w*|issue|problem|not working|broke\w*|defect\w*|worst|refund|delay\w*|no response|pathetic|cheat\w*|fraud|poor service|bad service)\b/i;

export function commentFlags(c: Pick<DashComment, "sentiment" | "text">): Flag[] {
  const f = FLAGS[c.sentiment];
  if (!f) return [];
  return f === "negative" && COMPLAINT.test(c.text) ? ["negative", "complaint"] : [f];
}

const firstLine = (s: string, n = 160) => {
  const line = (s.split(/\n/).find((l) => l.trim()) ?? "").replace(/\s+/g, " ").trim();
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};
const istTime = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(iso)) + " IST"
    : "time unknown";
const eng = (p: DashPost) => p.likes + p.comments; // as on the dashboard's standouts

export type DigestPost = {
  page: string;
  time_ist: string;
  posted_at: string;
  first_line: string;
  url: string;
  reactions: number;
  comments: number;
  reposts: number;
};

export type OrmDigest = {
  generated_at: string;
  window: { hours: number; from: string; to: string };
  sync_health: { kind: string; started_at: string; time_ist: string; status: string; reason: string | null }[];
  montra_posts: DigestPost[];
  comments_needing_response: {
    page: string;
    post_url: string;
    commenter: string;
    headline: string | null;
    text: string;
    posted_at: string | null;
    time_ist: string;
    sentiment: string;
    flags: Flag[];
    comment_url: string | null;
  }[];
  older_open_comments: number; // still open, posted in the BASELINE_DAYS before the window
  mentions: {
    channel: "LinkedIn" | "X";
    author: string;
    headline: string | null;
    text: string;
    url: string | null;
    time_ist: string;
    sentiment: string;
    needs_response: boolean;
    media: boolean;
    montra_team: boolean;
  }[];
  competitors: {
    name: string;
    posts: (DigestPost & { engagement: number })[];
    last_checked_ist: string | null; // competitors are synced every few days, so "no post" may mean "not checked"
  }[];
  signals: string[];
};

export function buildOrmDigest(i: OrmDigestInput): OrmDigest {
  const to = i.now.getTime();
  const from = to - i.hours * 3_600_000;
  const inWindow = (iso: string | null) => !!iso && Date.parse(iso) >= from && Date.parse(iso) <= to;
  const name = new Map(i.brands.map((b) => [b.id, b.name]));
  const montra = new Set(i.brands.filter((b) => b.is_montra).map((b) => b.id));
  const toPost = (p: DashPost): DigestPost => ({
    page: name.get(p.brand) ?? p.brand,
    time_ist: istTime(p.posted_at),
    posted_at: p.posted_at,
    first_line: firstLine(p.text),
    url: p.url,
    reactions: p.likes,
    comments: p.comments,
    reposts: p.reposts,
  });
  const newest = (a: { posted_at: string | null }, b: { posted_at: string | null }) =>
    (b.posted_at ?? "").localeCompare(a.posted_at ?? "");
  const recent = i.posts.filter((p) => inWindow(p.posted_at)).sort(newest);

  // Comments: people's comments on Resonia's posts, flagged and not yet handled.
  const people = i.comments.filter((c) => !c.page_reply && !c.channel);
  const open = people.filter(isOpen);
  const comments = open
    .filter((c) => inWindow(c.posted_at))
    .sort(newest)
    .map((c) => ({
      page: name.get(c.brand) ?? c.brand,
      post_url: c.post_url,
      commenter: c.name,
      headline: c.headline,
      text: c.text,
      posted_at: c.posted_at,
      time_ist: istTime(c.posted_at),
      sentiment: c.sentiment,
      flags: commentFlags(c),
      comment_url: c.url,
    }));
  const baseFrom = from - BASELINE_DAYS * 86_400_000;
  const before = (iso: string | null) => !!iso && Date.parse(iso) >= baseFrom && Date.parse(iso) < from;

  const mentions = i.mentions
    .filter((c) => !c.page_reply && inWindow(c.posted_at))
    .sort(newest)
    .map((c) => ({
      channel: (c.channel === "x" ? "X" : "LinkedIn") as "LinkedIn" | "X",
      author: c.name,
      headline: c.headline,
      text: c.text,
      url: c.url ?? (c.post_url.startsWith("http") ? c.post_url : null),
      time_ist: istTime(c.posted_at),
      sentiment: c.sentiment,
      needs_response: c.needs_response && !c.handled,
      media: !!c.media,
      montra_team: !!c.li?.staff,
    }));

  // Each page's own average (likes + comments) over the loaded 90 days, with at least 3 posts.
  const avg = new Map<string, number>();
  for (const b of i.brands) {
    const own = i.posts.filter((p) => p.brand === b.id);
    if (own.length >= 3) avg.set(b.id, own.reduce((s, p) => s + eng(p), 0) / own.length);
  }
  const competitors = i.brands
    .filter((b) => !b.is_montra)
    .map((b) => ({
      name: b.name,
      posts: recent.filter((p) => p.brand === b.id).map((p) => ({ ...toPost(p), engagement: eng(p) })),
      last_checked_ist: b.last_synced_at ? istTime(b.last_synced_at) : null,
    }));

  const signals: string[] = [];
  for (const p of recent.filter((p) => !montra.has(p.brand))) {
    const a = avg.get(p.brand);
    if (a && eng(p) >= STANDOUT_MULTIPLE * a) {
      signals.push(
        `${name.get(p.brand)} post at ${(eng(p) / a).toFixed(1)}× its own average (${eng(p)} vs ${Math.round(a)} reactions + comments): "${firstLine(p.text, 100)}" ${p.url}`,
      );
    }
  }
  const neg = (c: DashComment) => c.sentiment === "Negative";
  const negNow = people.filter((c) => neg(c) && inWindow(c.posted_at)).length;
  const negUsual = people.filter((c) => neg(c) && before(c.posted_at)).length / ((BASELINE_DAYS * 24) / i.hours);
  if (negNow >= SPIKE_MIN && negNow >= SPIKE_MULTIPLE * negUsual) {
    signals.push(
      `Negative comments spiked: ${negNow} in the last ${i.hours} hours vs about ${negUsual.toFixed(1)} usually (average over the ${BASELINE_DAYS} days before)`,
    );
  }
  const negMentions = mentions.filter((m) => m.sentiment === "Negative").length;
  if (negMentions) signals.push(`${negMentions} negative mention${negMentions === 1 ? "" : "s"} of Resonia`);

  return {
    generated_at: i.now.toISOString(),
    window: { hours: i.hours, from: new Date(from).toISOString(), to: i.now.toISOString() },
    sync_health: i.runs
      .slice(0, 3)
      .map((r) => ({
        kind: r.kind ?? "evening",
        started_at: r.started_at,
        time_ist: istTime(r.started_at),
        status: r.status,
        reason:
          runReason(r.status, r.notes, name) ?? (r.status === "success" || r.status === "running" ? null : r.notes),
      })),
    montra_posts: recent.filter((p) => montra.has(p.brand)).map(toPost),
    comments_needing_response: comments,
    older_open_comments: open.filter((c) => before(c.posted_at)).length,
    mentions,
    competitors,
    signals,
  };
}

// Plain text for the agent: one section per heading, "None" when empty. Long mention posts are cut
// at 400 characters here; ?format=json has them in full.
export function ormDigestText(d: OrmDigest): string {
  const L: string[] = [
    `Resonia ORM digest: last ${d.window.hours} hours, generated ${istTime(d.generated_at)}`,
    "",
    "A) SYNC HEALTH (last 3 runs)",
  ];
  if (!d.sync_health.length) L.push("- No runs recorded");
  for (const r of d.sync_health)
    L.push(`- ${r.kind}, ${r.time_ist}: ${r.status}${r.reason ? `. Reason: ${r.reason}` : ""}`);

  L.push("", `B) MONTRA NEW POSTS (${d.montra_posts.length})`);
  if (!d.montra_posts.length) L.push("- None");
  for (const p of d.montra_posts) {
    L.push(`- ${p.page}, ${p.time_ist}: "${p.first_line}"`);
    L.push(`  ${p.url}`);
    L.push(`  ${p.reactions} reactions, ${p.comments} comments, ${p.reposts} reposts`);
  }

  L.push("", `C) COMMENTS NEEDING A RESPONSE (${d.comments_needing_response.length})`);
  if (!d.comments_needing_response.length) L.push("- None");
  for (const c of d.comments_needing_response) {
    L.push(`- [${c.flags.join(", ") || c.sentiment}] ${c.page}, ${c.time_ist}`);
    L.push(`  ${c.commenter}${c.headline ? ` (${c.headline})` : ""}: "${c.text.replace(/\s+/g, " ").trim()}"`);
    L.push(`  Post: ${c.post_url}`);
    if (c.comment_url) L.push(`  Comment: ${c.comment_url}`);
  }
  if (d.older_open_comments) {
    L.push(`  (${d.older_open_comments} older comment(s) from the week before are still open on the dashboard)`);
  }

  L.push("", `D) MENTIONS OF MONTRA BY OTHER ACCOUNTS (${d.mentions.length})`);
  if (!d.mentions.length) L.push("- None");
  for (const m of d.mentions) {
    const tags = [
      m.channel,
      m.sentiment,
      m.media ? "media" : null,
      m.montra_team ? "Resonia team" : null,
      m.needs_response ? "needs response" : null,
    ].filter(Boolean);
    L.push(`- [${tags.join(", ")}] ${m.author}, ${m.time_ist}: "${firstLine(m.text.replace(/\s+/g, " "), 400)}"`);
    if (m.url) L.push(`  ${m.url}`);
  }

  L.push("", "E) COMPETITOR POSTS");
  for (const c of d.competitors) {
    if (!c.posts.length) {
      L.push(`- ${c.name}: no post${c.last_checked_ist ? ` (last checked ${c.last_checked_ist})` : ""}`);
      continue;
    }
    for (const p of c.posts) {
      L.push(`- ${c.name}, ${p.time_ist}: "${p.first_line}"`);
      L.push(`  ${p.url}`);
      L.push(`  ${p.reactions} reactions, ${p.comments} comments, ${p.reposts} reposts`);
    }
  }

  L.push("", "F) NOTABLE SIGNALS");
  if (!d.signals.length) L.push("- None");
  for (const s of d.signals) L.push(`- ${s}`);
  return L.join("\n") + "\n";
}

// ?hours=48: a whole number of hours from 1 to MAX_HOURS; anything else gives the default.
export function parseHours(v: string | null): number {
  const n = v == null ? NaN : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_HOURS ? n : DEFAULT_HOURS;
}
