"use client";

import { useEffect, useMemo, useState } from "react";
import { LowData } from "@/app/Insights";
import {
  earnedOwned,
  fmtHours,
  growthStats,
  mediaOutlets,
  responseTimes,
  trends,
  type CurveSide,
  type TrendPoint,
  type TrendSeries,
  type Week,
} from "@/lib/analytics";
import type { DashBrand, DashComment, DashPost, DashXPost, FollowerPoint, LiExportData } from "@/lib/dashboard";
import {
  CLICKS_NOT_PUBLIC,
  KIND_LABEL,
  NOT_PUBLIC,
  PAGE_IMPRESSIONS,
  POST_IMPRESSIONS,
  PUBLIC_INTERACTIONS,
  REACH_MODES,
  VIDEO_CTR_NOTE,
  daysOf,
  fmtCtr,
  fmtDays,
  liLabel,
  missingDays,
  pageTotals,
  postReach,
  publicInteractions,
  type ExportKind,
  type ReachMode,
} from "@/lib/reach";
import { LOW_DATA } from "@/lib/insights";
import { fmtCompact, fmtDate, fmtInt, fmtPct, fmtPostTime, istDay, type SegmentFilter } from "@/lib/metrics";
import { inRange, type DateRange } from "@/lib/range";

const shortDay = (d: string) => fmtDate(`${d}T12:00:00+05:30`);
const weekLabel = (w: Week) => `${shortDay(w.from)} – ${shortDay(w.to)}${w.partial ? " (part week)" : ""}`;

// ---------- line chart with hover ----------

type Line = { name: string; points: TrendPoint[]; color: string; dashed?: boolean; width?: number };

function LineChart({
  title,
  weeks,
  lines,
  format,
}: {
  title: string;
  weeks: Week[];
  lines: Line[];
  format: (n: number | null) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 320;
  const H = 150;
  const pad = { l: 8, r: 8, t: 10, b: 22 };
  const vals = lines.flatMap((l) => l.points.map((p) => p.value)).filter((v): v is number => v != null);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (!vals.length) [lo, hi] = [0, 1];
  if (lo === hi) [lo, hi] = [lo * 0.95, hi * 1.05 || 1];
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const x = (i: number) =>
    pad.l + (weeks.length < 2 ? (W - pad.l - pad.r) / 2 : (i * (W - pad.l - pad.r)) / (weeks.length - 1));
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
  const step = weeks.length < 2 ? W : (W - pad.l - pad.r) / (weeks.length - 1);

  return (
    <div className="trend">
      <div className="trend-head">
        <span className="kpi-label">{title}</span>
        <span className="trend-range">
          {format(lo + span * 0.08)} – {format(hi - span * 0.08)}
        </span>
      </div>
      <div className="trend-box" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, week by week`}>
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="trend-cursor" />}
          {lines.map((l) => {
            const segs: string[] = [];
            let d = "";
            l.points.forEach((p, i) => {
              if (p.value == null) {
                if (d) segs.push(d);
                d = "";
                return;
              }
              d += `${d ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`;
            });
            if (d) segs.push(d);
            return (
              <g key={l.name}>
                {segs.map((s, i) => (
                  <path
                    key={i}
                    d={s}
                    fill="none"
                    stroke={l.color}
                    strokeWidth={l.width ?? 2}
                    strokeDasharray={l.dashed ? "4 3" : undefined}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                  />
                ))}
                {l.points.map((p, i) =>
                  p.value == null ? null : (
                    <circle
                      key={i}
                      cx={x(i)}
                      cy={y(p.value)}
                      r={hover === i ? 4 : 2.6}
                      fill={p.low ? "var(--surface)" : l.color}
                      stroke={l.color}
                      strokeWidth={1.5}
                    />
                  ),
                )}
              </g>
            );
          })}
          {weeks.map((w, i) => (
            <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="trend-axis">
              {weeks.length > 8 && i % 2 ? "" : shortDay(w.to)}
            </text>
          ))}
          {weeks.map((_, i) => (
            <rect
              key={i}
              x={x(i) - step / 2}
              y={0}
              width={step}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)}
              tabIndex={0}
              aria-label={`${weekLabel(weeks[i])}: ${lines.map((l) => `${l.name} ${format(l.points[i].value)}`).join(", ")}`}
            />
          ))}
        </svg>
        {hover != null && (
          <div
            className="trend-tip"
            role="status"
            // Kept inside the chart near the edges.
            style={
              x(hover) / W > 0.65
                ? { right: 0 }
                : x(hover) / W < 0.35
                  ? { left: 0 }
                  : { left: `${(x(hover) / W) * 100}%`, transform: "translateX(-50%)" }
            }
          >
            <b>{weekLabel(weeks[hover])}</b>
            {lines.map((l) => {
              const p = l.points[hover];
              return (
                <div key={l.name}>
                  <i style={{ background: l.color }} /> {l.name}: <b>{format(p.value)}</b>
                  {p.low && p.value != null ? ` (low data, ${p.n} ${p.n === 1 ? "post" : "posts"})` : ""}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Overview: trend lines ----------

export function TrendsCard({
  posts,
  brands,
  followers,
  range,
  segment,
}: {
  posts: DashPost[];
  brands: DashBrand[];
  followers: FollowerPoint[];
  range: DateRange;
  segment: SegmentFilter;
}) {
  const [page, setPage] = useState("");
  const t = useMemo(() => trends(posts, brands, followers, range, segment), [posts, brands, followers, range, segment]);
  const picked = t.pages.find((p) => p.id === page) ?? null;
  const lines = (k: "followers" | "posts" | "rate"): Line[] => {
    const avg = (s: TrendSeries, color: string): Line => ({
      name: s.name,
      points: s[k],
      color,
      dashed: !!picked,
      width: picked ? 1.5 : 2,
    });
    const out: Line[] = [];
    if (t.montra.followers.some((p) => p.n) || t.montra.posts.some((p) => p.value))
      out.push(avg(t.montra, "var(--teal)"));
    if (t.comp.followers.some((p) => p.n) || t.comp.posts.some((p) => p.value))
      out.push(avg(t.comp, "var(--comp-ink)"));
    if (picked) out.push({ name: picked.name, points: picked[k], color: "var(--ink)", width: 2.5 });
    return out;
  };
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Trends</h2>
          <div className="card-sub">
            Week by week (weeks end on the range&apos;s last day). Hover a week for exact values; hollow points are low
            data (fewer than {LOW_DATA} posts).
          </div>
        </div>
        <select className="select" aria-label="Page" value={picked?.id ?? ""} onChange={(e) => setPage(e.target.value)}>
          <option value="">Resonia vs competitor average</option>
          {t.pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {t.weeks.length < 2 && (
        <p className="coverage">Pick a range of two weeks or more to see a trend; this range is a single week.</p>
      )}
      <div className="trend-grid">
        <LineChart
          title="Followers (average per page)"
          weeks={t.weeks}
          lines={lines("followers")}
          format={fmtCompact}
        />
        <LineChart
          title="Posts per week (average per page)"
          weeks={t.weeks}
          lines={lines("posts")}
          format={(n) => (n == null ? "—" : n.toFixed(n < 10 && n % 1 ? 1 : 0))}
        />
        <LineChart
          title="Engagement rate"
          weeks={t.weeks}
          lines={lines("rate")}
          format={(n) => (n == null ? "—" : fmtPct(n, n < 0.001 ? 3 : 2))}
        />
      </div>
      <div className="trend-legend">
        <span>
          <i style={{ background: "var(--teal)" }} /> Resonia average
        </span>
        <span>
          <i style={{ background: "var(--comp-ink)" }} /> Competitor average
        </span>
        {picked && (
          <span>
            <i style={{ background: "var(--ink)" }} /> {picked.name}
          </span>
        )}
      </div>
    </section>
  );
}

// ---------- Insights: earned vs owned ----------

export function EarnedCard({
  comments,
  posts,
  xPosts,
  brands,
  range,
  segment,
}: {
  comments: DashComment[];
  posts: DashPost[];
  xPosts: DashXPost[];
  brands: DashBrand[];
  range: DateRange;
  segment: SegmentFilter;
}) {
  const e = useMemo(
    () => earnedOwned(comments, posts, xPosts, brands, range, segment),
    [comments, posts, xPosts, brands, range, segment],
  );
  const outlets = useMemo(() => mediaOutlets(comments, range), [comments, range]);
  const max = Math.max(1, ...e.weeks.map((w) => Math.max(w.liMedia + w.xMedia, w.liPosts + w.xPosts)));
  const bar = (n: number, cls: string) => <span className={`eo-bar ${cls}`} style={{ width: `${(n / max) * 100}%` }} />;
  return (
    <div className="grid-2">
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <h2>Earned vs owned</h2>
            <div className="card-sub">
              Media and brand pages mentioning Resonia (earned) against Resonia&apos;s own posts (owned), by week
            </div>
          </div>
        </div>
        <div className="table-scroll">
          <table className="perf eo">
            <thead>
              <tr>
                <th className="left">Week</th>
                <th>LinkedIn media</th>
                <th>X media</th>
                <th>Our LinkedIn posts</th>
                <th>Our X posts</th>
                <th className="left eo-col">Earned / owned</th>
              </tr>
            </thead>
            <tbody>
              {e.weeks.map((w) => (
                <tr key={w.to}>
                  <td>{weekLabel(w)}</td>
                  <td>{w.liMedia}</td>
                  <td>{w.xMedia}</td>
                  <td>{w.liPosts}</td>
                  <td>{w.xPosts}</td>
                  <td className="left eo-col">
                    <div className="eo-bars" title={`Earned ${w.liMedia + w.xMedia}, owned ${w.liPosts + w.xPosts}`}>
                      {bar(w.liMedia + w.xMedia, "earned")}
                      {bar(w.liPosts + w.xPosts, "owned")}
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="perf-total">
                <td>Total</td>
                <td>{e.total.liMedia}</td>
                <td>{e.total.xMedia}</td>
                <td>{e.total.liPosts}</td>
                <td>{e.total.xPosts}</td>
                <td className="left eo-col muted">
                  {e.total.liMedia + e.total.xMedia} earned · {e.total.liPosts + e.total.xPosts} owned
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="trend-legend">
          <span>
            <i className="earned" /> Earned (media mentions)
          </span>
          <span>
            <i className="owned" /> Owned (our posts)
          </span>
        </div>
      </section>
      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <h2>Media outlets</h2>
            <div className="card-sub">Media and brand pages that mentioned Resonia in this period</div>
          </div>
        </div>
        {outlets.length === 0 ? (
          <div className="empty">No media mentions in this period.</div>
        ) : (
          <div className="table-scroll">
            <table className="perf">
              <thead>
                <tr>
                  <th className="left">Page or account</th>
                  <th>Where</th>
                  <th>Mentions</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {outlets.map((o) => (
                  <tr key={`${o.channel}:${o.name}`}>
                    <td>
                      {o.url ? (
                        <a href={o.url} target="_blank" rel="noopener noreferrer">
                          {o.name} ↗
                        </a>
                      ) : (
                        o.name
                      )}
                    </td>
                    <td>{o.channel}</td>
                    <td>{o.count}</td>
                    <td>{fmtPostTime(o.last)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- Insights: post growth curve ----------

export function GrowthCard({ posts, brands }: { posts: DashPost[]; brands: DashBrand[] }) {
  const g = useMemo(() => growthStats(posts, brands), [posts, brands]);
  const side = (name: string, s: CurveSide, cls: string) => (
    <tr className={cls}>
      <td>{name}</td>
      {s.points.map((p) => (
        <td key={p.day}>
          {p.avg == null ? "—" : fmtInt(p.avg)} <LowData a={p} />
        </td>
      ))}
      <td>
        {s.eightyDay == null ? (
          <span className="muted">not enough data yet</span>
        ) : (
          <>
            {s.eightyDay === 0 ? "the day it is posted" : `by day ${s.eightyDay}`}{" "}
            <LowData a={{ n: s.n7, low: s.n7 < LOW_DATA }} />
          </>
        )}
      </td>
    </tr>
  );
  const sentence = (name: string, s: CurveSide) =>
    s.eightyDay == null
      ? null
      : `A typical ${name} post has 80% of its first-week likes + comments ${
          s.eightyDay === 0 ? "on the day it is posted" : `by day ${s.eightyDay}`
        } (${s.n7} ${s.n7 === 1 ? "post" : "posts"} counted on day 1 and day 7${s.n7 < LOW_DATA ? ", low data" : ""}).`;
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Post growth curve</h2>
          <div className="card-sub">Average likes + comments 1, 3 and 7 days after posting, from the daily counts</div>
        </div>
      </div>
      <div className="table-scroll">
        <table className="perf">
          <thead>
            <tr>
              <th className="left" />
              <th>Day 1</th>
              <th>Day 3</th>
              <th>Day 7</th>
              <th>80% of engagement</th>
            </tr>
          </thead>
          <tbody>
            {side("Resonia", g.montra, "montra")}
            {side("Competitors", g.comp, "")}
          </tbody>
        </table>
      </div>
      {[sentence("Resonia", g.montra), sentence("competitor", g.comp)].filter(Boolean).map((s) => (
        <p key={s} className="note">
          {s}
        </p>
      ))}
      <p className="note muted">
        Day 0 is the day a post went out (IST). Each sync reads the latest 3–5 posts per page, so a post only has daily
        counts while it is among its page&apos;s latest; busy pages&apos; posts drop out before day 7. Curves fill in as
        daily syncs build up.
      </p>
    </section>
  );
}

// ---------- Comments tab: response time ----------

export function ResponseCard({ comments, range, now }: { comments: DashComment[]; range: DateRange; now: string }) {
  const s = useMemo(() => responseTimes(comments, range, now), [comments, range, now]);
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Response time</h2>
          <div className="card-sub">
            Resonia LinkedIn comments and X customer tweets that need a response: time to Resonia&apos;s first reply
          </div>
        </div>
      </div>
      <div className="rt-tiles">
        <div>
          <div className="kpi-label">Average</div>
          <div className="rt-value">
            {fmtHours(s.avgHours)} <LowData a={{ n: s.answered.length, low: s.low }} />
          </div>
        </div>
        <div>
          <div className="kpi-label">Median</div>
          <div className="rt-value">{fmtHours(s.medianHours)}</div>
        </div>
        <div>
          <div className="kpi-label">Answered</div>
          <div className="rt-value">
            {s.answered.length} <span className="muted">of {s.items.length}</span>
          </div>
        </div>
        <div>
          <div className="kpi-label">Unanswered 24h+</div>
          <div className={`rt-value${s.over24 ? " down" : ""}`}>{s.over24}</div>
        </div>
        <div>
          <div className="kpi-label">Unanswered 48h+</div>
          <div className={`rt-value${s.over48 ? " down" : ""}`}>{s.over48}</div>
        </div>
      </div>
      {s.slowest.length > 0 && (
        <>
          <h3 className="digest-h3">Slowest replies</h3>
          <ul className="rt-slow">
            {s.slowest.map((w) => (
              <li key={w.item.id}>
                <b>{fmtHours(w.hours)}</b> · {w.item.channel === "x" ? "X" : "LinkedIn"} · {w.item.name},{" "}
                {fmtPostTime(w.item.posted_at)}: &ldquo;
                {w.item.text.length > 90 ? `${w.item.text.slice(0, 89)}…` : w.item.text}&rdquo;{" "}
                {(w.item.url ?? (w.item.channel ? null : w.item.post_url)) && (
                  <a href={(w.item.url ?? w.item.post_url) as string} target="_blank" rel="noopener noreferrer">
                    Open ↗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="note muted">
        Counts items posted in this period. Unanswered = no public reply from Resonia and not marked handled
        {s.handledNoReply ? `; ${s.handledNoReply} marked handled without a public reply are left out` : ""}.
      </p>
    </section>
  );
}

// ---------- Insights: reach from uploaded LinkedIn exports ----------

const SPLIT_NOTE_KEY = "pulse.reach.splitNoteHidden";

const pctOrDash = (v: number | null) => (v == null ? "—" : fmtCtr(v));
const intOrDash = (v: number | null) => (v == null ? "—" : fmtInt(v));

export function ReachCard({
  li,
  posts,
  brands,
  range,
  signedIn = false,
  ads = [],
  onMarkAd,
}: {
  li: LiExportData;
  posts: DashPost[];
  brands: DashBrand[]; // the segment's pages
  range: DateRange;
  signedIn?: boolean; // the re-upload note is for the team; the public view only gets the tag
  ads?: DashPost[]; // Resonia ads known only from exports ("Ad (not on feed)")
  onMarkAd?: (post: DashPost, ad: boolean | null) => void; // signed in, after schema.sql
}) {
  const [mode, setMode] = useState<ReachMode>("organic");
  // The "re-upload for organic numbers" note, once dismissed, stays hidden in this browser.
  // Unknown (null) until read after mount, so it never flashes for someone who dismissed it.
  const [noteHidden, setNoteHidden] = useState<boolean | null>(null);
  useEffect(() => {
    try {
      setNoteHidden(window.localStorage.getItem(SPLIT_NOTE_KEY) === "1");
    } catch {
      setNoteHidden(false);
    }
  }, []);
  const hideNote = () => {
    setNoteHidden(true);
    try {
      window.localStorage.setItem(SPLIT_NOTE_KEY, "1");
    } catch {
      // storage blocked: hidden for this visit only
    }
  };
  const montra = useMemo(() => brands.filter((b) => b.is_montra), [brands]);
  const r = useMemo(() => postReach(posts, brands, range), [posts, brands, range]);
  const adsInRange = useMemo(
    () =>
      ads
        .filter((p) => inRange(istDay(p.posted_at), range) && brands.some((b) => b.id === p.brand))
        .sort((a, b) => b.posted_at.localeCompare(a.posted_at)),
    [ads, range, brands],
  );
  const total = useMemo(
    () =>
      pageTotals(
        li,
        range,
        montra.map((b) => b.id),
        mode,
      ),
    [li, range, montra, mode],
  );
  const byPage = useMemo(
    () => new Map(montra.map((b) => [b.id, pageTotals(li, range, [b.id], mode)])),
    [li, range, montra, mode],
  );
  const gaps = useMemo(() => missingDays(li, range, montra), [li, range, montra]);
  const days = daysOf(range).length;
  const comp = useMemo(() => {
    const list = posts.filter(
      (p) => inRange(istDay(p.posted_at), range) && brands.some((b) => b.id === p.brand && !b.is_montra),
    );
    return { posts: list.length, interactions: list.reduce((a, p) => a + publicInteractions(p), 0) };
  }, [posts, brands, range]);
  const anyGap = gaps.some((g) => Object.values(g.missing).some((d) => d.length));

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Reach and engagement</h2>
          <div className="card-sub">
            Resonia pages, {liLabel(li)}. Competitors: {PUBLIC_INTERACTIONS.toLowerCase()} only.
          </div>
        </div>
        {li.ready && (
          <div className="seg seg-wrap" role="group" aria-label="Page totals: organic or sponsored">
            {REACH_MODES.map((m) => (
              <button key={m.id} aria-pressed={mode === m.id} onClick={() => setMode(m.id)} title={m.label}>
                {m.id === "all" ? "All" : m.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {!li.ready ? (
        <div className="empty">
          Re-run supabase/schema.sql, then use &ldquo;Upload LinkedIn analytics&rdquo; (team sign-in).
        </div>
      ) : (
        <>
          {signedIn && total.noSplit && noteHidden === false && (
            <div className="banner banner-dismiss" role="status">
              <span>
                These uploads were saved before organic and sponsored numbers were kept apart, so the page totals below
                are LinkedIn&apos;s totals (organic + sponsored). Re-run supabase/schema.sql and upload the Content
                exports again to see {mode} numbers.
              </span>
              <button className="banner-close" onClick={hideNote} aria-label="Dismiss this note">
                ×
              </button>
            </div>
          )}
          <h3 className="digest-h3">
            {PAGE_IMPRESSIONS}{" "}
            {total.noSplit && (
              <span
                className="tag mode-tag"
                title="Uploaded before organic and sponsored were kept apart: these are LinkedIn's totals. Upload the Content exports again to see organic numbers."
              >
                All (organic + sponsored)
              </span>
            )}
          </h3>
          <div className="rt-tiles reach-tiles">
            <Tile label="Impressions" value={intOrDash(total.impressions)} />
            <Tile label="Clicks" value={intOrDash(total.clicks)} />
            <Tile label="CTR" value={pctOrDash(total.ctr)} />
            <Tile label="Engagements" value={intOrDash(total.engagements)} />
            <Tile label="Engagement rate" value={pctOrDash(total.er)} />
            <Tile label="New followers" value={intOrDash(total.newFollowers)} />
            <Tile label="Page views" value={intOrDash(total.pageViews)} />
          </div>
          <p className="note muted">
            {total.noSplit ? "" : `${REACH_MODES.find((m) => m.id === mode)!.label} · `}Content numbers uploaded for{" "}
            {total.days} of {days} {days === 1 ? "day" : "days"}
            {anyGap ? " (missing dates below)" : ""}. Organic, sponsored and all come from the export&apos;s own
            columns; sponsored is your Campaign Manager ads. New followers and page views are not split.
          </p>

          <h3 className="digest-h3">
            {POST_IMPRESSIONS} <span className="tag mode-tag">Organic: posts on Resonia feeds</span>
          </h3>
          <div className="table-scroll">
            <table className="perf">
              <thead>
                <tr>
                  <th className="left">Page</th>
                  <th>Posts</th>
                  <th>With export</th>
                  <th>Impressions</th>
                  <th>Per post</th>
                  <th>Clicks</th>
                  <th>CTR</th>
                  <th title={VIDEO_CTR_NOTE}>CTR without video</th>
                  <th>Engagements</th>
                  <th>Eng. rate</th>
                  <th title={PAGE_IMPRESSIONS}>Page impressions (daily totals)</th>
                </tr>
              </thead>
              <tbody>
                {r.pages.map((p) => {
                  const t = byPage.get(p.brand.id)!;
                  return (
                    <tr key={p.brand.id} className="montra">
                      <td>
                        <div className="page-name">{p.brand.name}</div>
                        {p.reach.videos > 0 && (
                          <div className="muted small">
                            {p.reach.videos} video {p.reach.videos === 1 ? "post" : "posts"}
                          </div>
                        )}
                      </td>
                      <td>{p.posts}</td>
                      <td>{p.reach.posts}</td>
                      <td>{p.reach.posts ? fmtInt(p.reach.impressions) : "—"}</td>
                      <td>
                        {p.reach.avgImpressions == null ? "—" : fmtInt(p.reach.avgImpressions)}{" "}
                        <LowData a={{ n: p.reach.posts, low: p.reach.low }} />
                      </td>
                      <td>{p.reach.posts ? fmtInt(p.reach.clicks) : "—"}</td>
                      <td>{fmtCtr(p.reach.ctr)}</td>
                      <td>{fmtCtr(p.reach.ctrExVideo)}</td>
                      <td>{p.reach.posts ? fmtInt(p.reach.engagements) : "—"}</td>
                      <td>{fmtCtr(p.reach.er)}</td>
                      <td>{intOrDash(t.impressions)}</td>
                    </tr>
                  );
                })}
                <tr className="perf-total">
                  <td>All Resonia pages</td>
                  <td>{r.pages.reduce((a, p) => a + p.posts, 0)}</td>
                  <td>{r.all.posts}</td>
                  <td>{r.all.posts ? fmtInt(r.all.impressions) : "—"}</td>
                  <td>
                    {r.all.avgImpressions == null ? "—" : fmtInt(r.all.avgImpressions)}{" "}
                    <LowData a={{ n: r.all.posts, low: r.all.low }} />
                  </td>
                  <td>{r.all.posts ? fmtInt(r.all.clicks) : "—"}</td>
                  <td>{fmtCtr(r.all.ctr)}</td>
                  <td>{fmtCtr(r.all.ctrExVideo)}</td>
                  <td>{r.all.posts ? fmtInt(r.all.engagements) : "—"}</td>
                  <td>{fmtCtr(r.all.er)}</td>
                  <td>{intOrDash(total.impressions)}</td>
                </tr>
                <tr>
                  <td>
                    <div className="page-name">Competitors</div>
                    <div className="muted small">{PUBLIC_INTERACTIONS}</div>
                  </td>
                  <td>{comp.posts}</td>
                  <td className="muted">—</td>
                  <td className="muted">{NOT_PUBLIC}</td>
                  <td className="muted">—</td>
                  <td className="muted">{NOT_PUBLIC}</td>
                  <td className="muted">—</td>
                  <td className="muted">—</td>
                  <td title={CLICKS_NOT_PUBLIC}>
                    {fmtInt(comp.interactions)} <span className="muted small">public interactions</span>
                  </td>
                  <td className="muted">—</td>
                  <td className="muted">{NOT_PUBLIC}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="note muted">
            Engagements = reactions + comments + reposts + clicks (LinkedIn&apos;s definition). CTR = total clicks ÷
            total impressions and engagement rate = total engagements ÷ total impressions, over the period; never an
            average of percentages. Every post on a Resonia feed is organic (ads run as dark posts and are listed below).{" "}
            {VIDEO_CTR_NOTE}; CTR is also shown without video posts. Post numbers are lifetime to the export date, for
            posts published in this period. Competitors: {CLICKS_NOT_PUBLIC}
          </p>

          <h3 className="digest-h3">Paid ads (from export)</h3>
          {adsInRange.length ? (
            <div className="table-scroll">
              <table className="perf">
                <thead>
                  <tr>
                    <th className="left">Ad</th>
                    <th className="left">Page</th>
                    <th>Impressions</th>
                    <th>Clicks</th>
                    <th>CTR</th>
                    {onMarkAd && <th />}
                  </tr>
                </thead>
                <tbody>
                  {adsInRange.map((p) => (
                    <tr key={p.url}>
                      <td className="left ad-title">
                        <span className="muted small">{fmtDate(`${istDay(p.posted_at)}T12:00:00+05:30`, true)} · </span>
                        {p.text.slice(0, 90) || "(no text)"} <span className="tag origin-tag">Ad (not on feed)</span>
                      </td>
                      <td className="left">{brands.find((b) => b.id === p.brand)?.name ?? p.brand}</td>
                      <td>{intOrDash(p.li?.impressions ?? null)}</td>
                      <td>{intOrDash(p.li?.clicks ?? null)}</td>
                      <td>{fmtCtr(p.li?.ctr)}</td>
                      {onMarkAd && (
                        <td>
                          <button className="btn btn-sm" onClick={() => onMarkAd(p, false)}>
                            Mark as organic
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="note muted">
              No ads in this period. Export rows that match no post on a Resonia feed and are marked sponsored (or have
              no feed link) are listed here as &ldquo;Ad (not on feed)&rdquo; and left out of posts, Top posts,
              Insights, trends and theme and hashtag stats.
            </p>
          )}

          {anyGap && (
            <details className="missing-days">
              <summary>Missing dates in this period, per page</summary>
              <div className="table-scroll">
                <table className="perf">
                  <thead>
                    <tr>
                      <th className="left">Page</th>
                      {(Object.keys(KIND_LABEL) as ExportKind[]).map((k) => (
                        <th key={k} className="left">
                          {KIND_LABEL[k]} export
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {gaps.map((g) => (
                      <tr key={g.brand.id}>
                        <td>{g.brand.name}</td>
                        {(Object.keys(KIND_LABEL) as ExportKind[]).map((k) => (
                          <td key={k} className="left">
                            {g.missing[k].length ? fmtDays(g.missing[k]) : <span className="muted">none</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="kpi-label">{label}</div>
      <div className="rt-value">{value}</div>
    </div>
  );
}

// Overview: compact Resonia reach in the KPI row (organic, page daily totals).
export function ReachStrip({ li, brands, range }: { li: LiExportData; brands: DashBrand[]; range: DateRange }) {
  const t = useMemo(
    () =>
      pageTotals(
        li,
        range,
        brands.filter((b) => b.is_montra).map((b) => b.id),
        "organic",
      ),
    [li, range, brands],
  );
  if (!li.ready || !li.lastUploaded) return null;
  const sub = `${t.noSplit ? "All (organic + sponsored)" : "Organic"} · ${PAGE_IMPRESSIONS.toLowerCase()}, ${liLabel(li)}`;
  return (
    <section className="kpis reach-strip" aria-label="Resonia reach from LinkedIn exports">
      <div className="card">
        <div className="kpi-label">Resonia impressions</div>
        <div className="kpi-value">{intOrDash(t.impressions)}</div>
        <div className="kpi-foot">{sub}</div>
      </div>
      <div className="card">
        <div className="kpi-label">Resonia engagements</div>
        <div className="kpi-value">{intOrDash(t.engagements)}</div>
        <div className="kpi-foot">Reactions + comments + reposts + clicks · engagement rate {pctOrDash(t.er)}</div>
      </div>
      <div className="card">
        <div className="kpi-label">Resonia CTR</div>
        <div className="kpi-value">{pctOrDash(t.ctr)}</div>
        <div className="kpi-foot">Total clicks ÷ total impressions</div>
      </div>
      <div className="card">
        <div className="kpi-label">Resonia new followers</div>
        <div className="kpi-value">{intOrDash(t.newFollowers)}</div>
        <div className="kpi-foot">
          Content numbers for {t.days} of {daysOf(range).length} days
        </div>
      </div>
    </section>
  );
}
