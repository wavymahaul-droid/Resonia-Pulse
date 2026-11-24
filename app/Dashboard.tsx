"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Overview from "@/app/Overview";
import { RangePicker } from "@/app/RangePicker";
import {
  withExportFollowers,
  withFollowerFallback,
  type FollowerKpis,
  type RowNote,
} from "@/lib/followers";
import { fmtRange, rangePhrase, rangeQuery, type DateRange } from "@/lib/range";
import {
  CommentsTab,
  PostComments,
  useHandled,
  type CommentFilter,
} from "@/app/Comments";
import { XTab } from "@/app/XTab";
import { Highlights, InsightsTab } from "@/app/Insights";
import {
  EarnedCard,
  GrowthCard,
  ReachCard,
  ResponseCard,
  TrendsCard,
} from "@/app/Analytics";
import { LinkedInUpload } from "@/app/LinkedInUpload";
import { OriginTag, ReachLine } from "@/app/Reach";
import { liLabel } from "@/lib/reach";
import { hashtags, highlights, insightRows } from "@/lib/insights";
import type {
  DashboardData,
  DashBrand,
  DashComment,
  DashPost,
} from "@/lib/dashboard";
import { isOpen } from "@/lib/orm";
import { X_BRAND } from "@/lib/x";
import { RUN_KINDS, runReason, RUN_LABEL } from "@/lib/runs";
import { LI_EXPORTS_ENABLED, ORM_ENABLED } from "@/lib/brands";
import { skippedLines } from "@/lib/health";
import SyncHealth from "./SyncHealth";
import VideoInsights from "./VideoInsights";
import {
  SEGMENT_FILTERS,
  brandStats,
  fmtCompact,
  fmtDate,
  fmtDateTime,
  fmtDec,
  fmtPostTime,
  fmtInt,
  fmtPct,
  fmtSigned,
  inSegment,
  istDay,
  kpis,
  postsCsv,
  postsInRange,
  postType,
  POST_TYPES,
  type BrandStats,
  type PostType,
  type SegmentFilter,
} from "@/lib/metrics";

// The maintenance guide on GitHub; each banner links to it.
const MAINTENANCE_URL =
  "https://github.com/wavymahaul-droid/Resonia-Pulse/blob/main/MAINTENANCE.md";

const SEGMENT_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  x: "X",
};

// ---------- tooltip ----------

type Tip = { x: number; y: number; body: ReactNode } | null;

function useTip() {
  const [tip, setTip] = useState<Tip>(null);
  const bind = (body: ReactNode) => ({
    onPointerMove: (e: React.PointerEvent) =>
      setTip({ x: e.clientX, y: e.clientY, body }),
    onPointerLeave: () => setTip(null),
  });
  const node = tip && (
    <div
      className="tip"
      role="tooltip"
      style={{
        left: Math.min(
          tip.x + 14,
          (typeof window !== "undefined" ? window.innerWidth : 9999) - 272,
        ),
        top: tip.y + 14,
      }}
    >
      {tip.body}
    </div>
  );
  return { bind, node };
}

// ---------- page ----------

export type Tab = "overview" | "insights" | "comments" | "x";

export default function Dashboard({
  data,
  signedIn,
  publicMode,
  initialRange,
  initialTab = "overview",
}: {
  data: DashboardData;
  signedIn: boolean;
  publicMode: boolean;
  initialRange: DateRange;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  // One date range for every tab (and the digest link); it lives in the page link too.
  const [range, setRange] = useState<DateRange>(initialRange);
  const today = istDay(data.generatedAt);
  useEffect(() => {
    // A range older than the data loaded for this page needs a fresh load from the server.
    if (range.from < istDay(data.loadedSince)) {
      window.location.assign(
        `/?${rangeQuery(range)}${tab === "overview" ? "" : `&tab=${tab}`}`,
      );
      return;
    }
    try {
      window.history.replaceState(
        null,
        "",
        `/?${rangeQuery(range)}${tab === "overview" ? "" : `&tab=${tab}`}`,
      );
    } catch {
      // ignore
    }
  }, [range, tab, data.loadedSince]);
  const [commentFilter, setCommentFilter] = useState<CommentFilter>({
    sentiment: "all",
    openOnly: false,
  });
  const handled = useHandled(data.comments);
  const canHandle = signedIn && !data.publicView;
  const openCount = handled.comments.filter(isOpen).length;
  const commentBrands = useMemo(
    () => [
      ...data.brands.filter((b) => b.track_comments),
      ...(data.x.ready ? [X_BRAND] : []),
    ],
    [data.brands, data.x.ready],
  );
  // The Comments tab is the customer inbox: X media mentions stay on the X tab unless flagged.
  const inbox = useMemo(
    () =>
      handled.comments.filter(
        (c) => c.channel === "li_mention" || !c.media || c.needs_response,
      ),
    [handled.comments],
  );
  const xComments = useMemo(
    () => handled.comments.filter((c) => c.channel === "x"),
    [handled.comments],
  );
  const xOpen = xComments.filter(isOpen).length;
  const commentsByPost = useMemo(() => {
    const m = new Map<string, DashComment[]>();
    for (const c of handled.comments)
      m.set(c.post_url, [...(m.get(c.post_url) ?? []), c]);
    return m;
  }, [handled.comments]);
  const [segment, setSegment] = useState<SegmentFilter>("all");
  // A hashtag clicked on the Insights tab filters the Overview post feed.
  const [hashtag, setHashtag] = useState<string | null>(null);
  useEffect(() => {
    if (hashtag && tab === "overview")
      document.getElementById("feed")?.scrollIntoView({ behavior: "smooth" });
  }, [hashtag, tab]);
  const tip = useTip();
  const [edits, setEdits] = useState<
    Map<string, { theme: string; theme_manual: boolean }>
  >(new Map());
  const [themeError, setThemeError] = useState<string | null>(null);

  // Ad / organic marks made on this page (signed in): the post moves between the feed and the
  // Reach card's "Paid ads (from export)" list at once.
  const [adEdits, setAdEdits] = useState<
    Map<string, { ad: boolean; adManual: boolean }>
  >(new Map());
  const [adError, setAdError] = useState<string | null>(null);

  // Theme changes made on this page apply at once to the feed, heatmap and leaderboard.
  const combined = useMemo(() => {
    const list = [...data.posts, ...data.ads];
    return edits.size || adEdits.size
      ? list.map((p) => ({ ...p, ...edits.get(p.url), ...adEdits.get(p.url) }))
      : list;
  }, [data.posts, data.ads, edits, adEdits]);
  const allPosts = useMemo(() => combined.filter((p) => !p.ad), [combined]);
  const ads = useMemo(() => combined.filter((p) => p.ad), [combined]);

  async function saveAd(post: DashPost, ad: boolean | null) {
    const before = { ad: !!post.ad, adManual: !!post.adManual };
    const put = (v: { ad: boolean; adManual: boolean }) =>
      setAdEdits((m) => new Map(m).set(post.url, v));
    if (ad != null) put({ ad, adManual: true });
    setAdError(null);
    try {
      const res = await fetch("/api/posts/ad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_url: post.url, ad }),
      });
      const body = await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      put({ ad: body.ad, adManual: body.ad_manual });
    } catch (err) {
      put(before);
      setAdError(
        `Could not save: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const markAd = signedIn && data.canMarkAds ? saveAd : undefined;

  async function saveTheme(post: DashPost, theme: string | null) {
    const before = { theme: post.theme, theme_manual: post.theme_manual };
    const put = (v: { theme: string; theme_manual: boolean }) =>
      setEdits((m) => new Map(m).set(post.url, v));
    if (theme) put({ theme, theme_manual: true });
    setThemeError(null);
    try {
      const res = await fetch("/api/posts/theme", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ post_url: post.url, theme }),
      });
      const body = await res
        .json()
        .catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      put({ theme: body.theme, theme_manual: body.theme_manual });
    } catch (err) {
      put(before);
      setThemeError(
        `Could not save the theme: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const brands = useMemo(
    () => data.brands.filter((b) => inSegment(b, segment)),
    [data.brands, segment],
  );
  const brandIds = useMemo(() => new Set(brands.map((b) => b.id)), [brands]);
  const posts = useMemo(
    () => postsInRange(allPosts, range).filter((p) => brandIds.has(p.brand)),
    [allPosts, range, brandIds],
  );
  const stats = useMemo(
    () => brandStats(brands, posts, data.followers, range),
    [brands, posts, data.followers, range],
  );
  // The leaderboard falls back to the next scraped count (and, for Resonia pages, the Followers
  // exports) when a period ends before follower counts began.
  const board = useMemo(
    () =>
      withFollowerFallback(stats, {
        followers: data.followers,
        days: data.liExport.pages,
        range,
      }),
    [stats, data.followers, data.liExport.pages, range],
  );
  // Follower KPIs fall back to the uploaded Followers exports when the scraped counts have no value.
  const k = useMemo(
    () =>
      withExportFollowers(kpis(stats), {
        days: data.liExport.pages,
        followers: data.followers,
        range,
        montraIds: brands.filter((b) => b.is_montra).map((b) => b.id),
      }),
    [stats, data.liExport.pages, data.followers, range, brands],
  );
  const rows = useMemo(
    () => insightRows(allPosts, data.brands, data.followers, range, segment),
    [allPosts, data.brands, data.followers, range, segment],
  );
  const callouts = useMemo(
    () =>
      highlights({
        posts: allPosts,
        brands: data.brands,
        followers: data.followers,
        range,
        segment,
        trackingSince: data.trackingSince,
      }),
    [allPosts, data.brands, data.followers, range, segment, data.trackingSince],
  );

  const periodLabel = rangePhrase(range);
  const pageNames = useMemo(
    () => new Map(data.brands.map((b) => [b.id, b.name])),
    [data.brands],
  );
  const montraIds = useMemo(
    () => new Set(data.brands.filter((b) => b.is_montra).map((b) => b.id)),
    [data.brands],
  );

  return (
    <div className="wrap">
      <header className="header">
        <div>
          <div className="eyebrow">
            LinkedIn · Instagram · Facebook · X · {data.brands.length} pages
          </div>
          <h1>
            Resonia <span className="accent">Competitive Pulse</span>
          </h1>
        </div>
        <div className="sync">
          {/* Morning and afternoon: X and LinkedIn mentions only; evening: everything. */}
          <span className="runs">
            {RUN_KINDS.filter((k) => ORM_ENABLED || k === "evening").map(
              (k) => {
                const r = data.lastRuns[k];
                return (
                  <span
                    key={k}
                    className="run"
                    title={
                      r
                        ? [
                            runReason(r.status, r.notes, pageNames),
                            r.notes,
                            skippedLines(data.health?.skipped ?? [], r.id).join(
                              "\n",
                            ),
                          ]
                            .filter(Boolean)
                            .join("\n\n") || undefined
                        : "Not run yet"
                    }
                  >
                    <span className={`dot ${r?.status ?? "none"}`} />
                    {RUN_LABEL[k]}{" "}
                    {r
                      ? fmtDateTime(r.finished_at ?? r.started_at)
                      : "not run yet"}
                    {r && r.status !== "success" && (
                      <span className="muted"> · {r.status}</span>
                    )}
                  </span>
                );
              },
            )}
          </span>
          {ORM_ENABLED && data.commentsReady && (
            <button
              className={`needs${openCount ? " on" : ""}`}
              onClick={() => {
                setTab("comments");
                setCommentFilter({ sentiment: "all", openOnly: true });
              }}
              title="Negative, Question and Lead comments on Resonia posts, X mentions and LinkedIn mentions not yet handled"
            >
              <b>{openCount}</b> needs response
            </button>
          )}
          {LI_EXPORTS_ENABLED && signedIn && (
            <LinkedInUpload
              pages={data.brands.filter((b) => b.is_montra)}
              lastUploaded={data.liExport.lastUploaded}
            />
          )}
          {signedIn && (
            <form method="post" action="/api/logout">
              <button className="btn" type="submit">
                Sign out
              </button>
            </form>
          )}
        </div>
      </header>

      {data.warnings.map((w) => (
        <div key={w} className="banner" role="alert">
          <strong>Sync warning:</strong> {w}{" "}
          <a href={MAINTENANCE_URL} target="_blank" rel="noopener noreferrer">
            How to fix
          </a>
        </div>
      ))}

      {data.health && (
        <SyncHealth
          runs={data.health.runs}
          skipped={data.health.skipped}
          rejectsReady={data.health.rejectsReady}
          maintenanceUrl={MAINTENANCE_URL}
        />
      )}

      <nav className="tabs" role="tablist" aria-label="View">
        <button
          role="tab"
          aria-selected={tab === "overview"}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          role="tab"
          aria-selected={tab === "insights"}
          onClick={() => setTab("insights")}
        >
          Insights
        </button>
        {ORM_ENABLED && (
          <>
            <button
              role="tab"
              aria-selected={tab === "comments"}
              onClick={() => setTab("comments")}
            >
              Comments
              {openCount > 0 && <span className="tab-count">{openCount}</span>}
            </button>
            <button
              role="tab"
              aria-selected={tab === "x"}
              onClick={() => setTab("x")}
            >
              X{xOpen > 0 && <span className="tab-count">{xOpen}</span>}
            </button>
          </>
        )}
        <a href={`/report?${rangeQuery(range)}`}>Report</a>
        <a href={`/top?${rangeQuery(range)}`}>Top posts</a>
      </nav>

      <div className="range-bar">
        <RangePicker
          range={range}
          today={today}
          onChange={setRange}
          buttons={
            tab === "overview" || tab === "insights"
              ? [
                  { key: "7d", label: "7 days" },
                  { key: "30d", label: "30 days" },
                  { key: "90d", label: "90 days" },
                  { key: "180d", label: "6 months" },
                ]
              : []
          }
        />
        <span className="muted">{fmtRange(range)} (IST)</span>
      </div>

      {tab === "x" ? (
        <XTab
          x={data.x}
          comments={xComments}
          range={range}
          canHandle={canHandle}
          publicView={data.publicView}
          onHandled={handled.setHandled}
          error={handled.error}
        />
      ) : tab === "comments" ? (
        <>
          <ResponseCard
            comments={handled.comments}
            range={range}
            now={data.generatedAt}
          />
          <CommentsTab
            comments={inbox}
            brands={commentBrands}
            posts={data.posts}
            ready={data.commentsReady}
            canHandle={canHandle}
            publicView={data.publicView}
            onHandled={handled.setHandled}
            error={handled.error}
            range={range}
            filter={commentFilter}
            setFilter={setCommentFilter}
          />
        </>
      ) : (
        <>
          <div className="filters">
            <div className="chips" role="group" aria-label="Segment">
              {SEGMENT_FILTERS.map((s) => (
                <button
                  key={s.id}
                  className={`chip${s.id === "montra" ? " montra" : ""}`}
                  aria-pressed={segment === s.id}
                  onClick={() => setSegment(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {tab === "insights" ? (
            <InsightsTab
              rows={rows}
              brands={brands}
              themes={data.themes}
              periodLabel={periodLabel}
              contentMix={
                <Heatmap
                  stats={stats}
                  themes={data.themes}
                  periodLabel={periodLabel}
                  bind={tip.bind}
                />
              }
              onHashtag={(t) => {
                setHashtag(t);
                setTab("overview");
              }}
              reach={
                LI_EXPORTS_ENABLED && (
                  <>
                    {adError && <div className="banner">{adError}</div>}
                    <ReachCard
                      li={data.liExport}
                      posts={allPosts}
                      brands={brands}
                      range={range}
                      signedIn={signedIn}
                      ads={ads}
                      onMarkAd={markAd}
                    />
                  </>
                )
              }
            >
              {data.trackingSince && (
                <p className="coverage">
                  Tracking since {fmtDate(data.trackingSince, true)}. Every
                  page&apos;s posts were backfilled from 24 May 2026; likes and
                  comments on backfilled posts are the totals on the day of the
                  backfill.
                </p>
              )}
              <Kpis k={k} periodLabel={periodLabel} segment={segment} />
              <Highlights items={callouts} periodLabel={periodLabel} />
              <TrendsCard
                posts={allPosts}
                brands={data.brands}
                followers={data.followers}
                range={range}
                segment={segment}
              />
              <div className="grid-2">
                <BarCard
                  title="Share of voice"
                  sub={`Share of all likes + comments, ${periodLabel}`}
                  stats={stats}
                  value={(s) => s.engagement}
                  total={stats.reduce((a, s) => a + s.engagement, 0)}
                  format={(v, total) => (total ? fmtPct(v / total) : "—")}
                  tipText={(s, total) =>
                    `${fmtInt(s.engagement)} likes + comments · ${total ? fmtPct(s.engagement / total) : "—"} of the total`
                  }
                  bind={tip.bind}
                />
                <BarCard
                  title="Posting volume"
                  sub={`Posts published, ${periodLabel}`}
                  stats={stats}
                  value={(s) => s.posts}
                  total={stats.reduce((a, s) => a + s.posts, 0)}
                  format={(v) => fmtInt(v)}
                  tipText={(s) =>
                    `${s.posts} posts · ${fmtDec(s.postsPerWeek)} per week`
                  }
                  bind={tip.bind}
                />
              </div>
              {ORM_ENABLED && (
                <EarnedCard
                  comments={handled.comments}
                  posts={allPosts}
                  xPosts={data.x.posts}
                  brands={data.brands}
                  range={range}
                  segment={segment}
                />
              )}
              <GrowthCard posts={posts} brands={data.brands} />
              {ORM_ENABLED && signedIn && data.videoInsights && (
                <VideoInsights
                  items={data.videoInsights}
                  pageName={(id) => pageNames.get(id) ?? id}
                  montraIds={montraIds}
                />
              )}
            </InsightsTab>
          ) : (
            <>
              <Overview
                posts={allPosts}
                allBrands={data.brands}
                brands={brands}
                li={data.liExport}
                comments={handled.comments}
                range={range}
                today={today}
                trackingSince={data.trackingSince}
                publicView={data.publicView}
                followers={data.followers}
                radar={data.radar}
                videos={signedIn ? (data.videoInsights ?? []) : []}
              />

              <details className="ov-details">
                <summary>
                  <span>Leaderboard</span>
                  <span className="muted">
                    Every page side by side, {periodLabel}
                  </span>
                </summary>
                <Leaderboard
                  stats={board.rows}
                  notes={board.notes}
                  periodLabel={periodLabel}
                />
              </details>

              <Feed
                posts={posts}
                brands={brands}
                allBrands={data.brands}
                stats={stats}
                segment={segment}
                range={range}
                themes={data.themes}
                canEditThemes={data.canEditThemes && signedIn}
                migrated={data.canEditThemes}
                onTheme={saveTheme}
                onMarkAd={markAd}
                themeError={themeError ?? adError}
                commentsByPost={commentsByPost}
                liText={liLabel(data.liExport)}
                canHandle={canHandle}
                onHandled={handled.setHandled}
                hashtag={hashtag}
                setHashtag={setHashtag}
              />
            </>
          )}
        </>
      )}

      {publicMode && !signedIn && (
        <footer className="footer">
          <a href="/login">Team sign-in</a>
        </footer>
      )}

      {tip.node}
    </div>
  );
}

// ---------- KPI tiles ----------

function Meter({
  montra,
  comp,
  format,
}: {
  montra: number | null;
  comp: number | null;
  format: (n: number | null) => string;
}) {
  const max = Math.max(montra ?? 0, comp ?? 0) || 1;
  return (
    <div className="kpi-meter">
      <div className="kpi-meter-row">
        <span>Resonia</span>
        <span className="track">
          <span
            style={{
              width: `${((montra ?? 0) / max) * 100}%`,
              background: "var(--teal)",
            }}
          />
        </span>
        <b>{format(montra)}</b>
      </div>
      <div className="kpi-meter-row">
        <span>Competitor avg</span>
        <span className="track">
          <span
            style={{
              width: `${((comp ?? 0) / max) * 100}%`,
              background: "var(--comp)",
            }}
          />
        </span>
        <b>{format(comp)}</b>
      </div>
    </div>
  );
}

function Kpis({
  k,
  periodLabel,
  segment,
}: {
  k: FollowerKpis;
  periodLabel: string;
  segment: SegmentFilter;
}) {
  const perPage = k.montraPageCount > 1 ? " per page" : "";
  const noComp = segment === "montra";
  return (
    <section className="kpis" aria-label="Key numbers">
      <div className="card">
        <div className="kpi-label">Resonia followers</div>
        <div className="kpi-value" title={k.followersNote}>
          {fmtCompact(k.montraFollowers)}
        </div>
        <div className="kpi-foot">
          {k.montraGrowth == null ? (
            "Growth shows once there are 2+ days of data"
          ) : (
            <>
              <span className={k.montraGrowth >= 0 ? "up" : "down"}>
                {fmtSigned(k.montraGrowth)} ({fmtPct(k.montraGrowthPct, 2)})
              </span>{" "}
              {periodLabel}
            </>
          )}
          {(k.followersNote || k.growthNote) && (
            <div className="muted small">
              {[
                k.followersNote && `Followers: ${k.followersNote}`,
                k.growthNote && `Growth: ${k.growthNote}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <div className="kpi-label">
          Posts{perPage}, {periodLabel}
        </div>
        <div className="kpi-value">{fmtDec(k.montraPostsPerPage)}</div>
        {noComp ? (
          <div className="kpi-foot">
            Pick a segment to compare with competitors
          </div>
        ) : (
          <Meter
            montra={k.montraPostsPerPage}
            comp={k.compPostsPerPage}
            format={(n) => fmtDec(n)}
          />
        )}
      </div>
      <div className="card">
        <div className="kpi-label">Engagement rate</div>
        <div className="kpi-value">{fmtPct(k.montraEr, 2)}</div>
        {noComp ? (
          <div className="kpi-foot">
            (Likes + comments) per post ÷ followers
          </div>
        ) : (
          <Meter
            montra={k.montraEr}
            comp={k.compEr}
            format={(n) => fmtPct(n, 2)}
          />
        )}
      </div>
      <div className="card">
        <div className="kpi-label">Resonia share of voice</div>
        <div className="kpi-value">{noComp ? "—" : fmtPct(k.montraSov)}</div>
        <div className="kpi-foot">
          {noComp
            ? "Needs competitors in view"
            : `Of all likes + comments in view, ${periodLabel}`}
        </div>
        {!noComp && k.montraSov != null && (
          <div className="kpi-meter">
            <span className="track">
              <span
                style={{
                  width: `${k.montraSov * 100}%`,
                  background: "var(--teal)",
                }}
              />
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- leaderboard ----------

type SortKey =
  | "name"
  | "followers"
  | "growth"
  | "posts"
  | "postsPerWeek"
  | "avgLikes"
  | "avgComments"
  | "engagementRate"
  | "topTheme"
  | "updated";

const COLUMNS: { key: SortKey; label: string; left?: boolean }[] = [
  { key: "name", label: "Page", left: true },
  { key: "followers", label: "Followers" },
  { key: "growth", label: "Growth" },
  { key: "posts", label: "Posts" },
  { key: "postsPerWeek", label: "Posts / wk" },
  { key: "avgLikes", label: "Avg likes" },
  { key: "avgComments", label: "Avg comments" },
  { key: "engagementRate", label: "Eng. rate" },
  { key: "topTheme", label: "Top theme", left: true },
  { key: "updated", label: "Last updated", left: true },
];

function sortValue(s: BrandStats, key: SortKey): number | string | null {
  switch (key) {
    case "name":
      return s.brand.name.toLowerCase();
    case "topTheme":
      return s.topTheme;
    case "updated":
      return s.brand.last_synced_at;
    default:
      return s[key];
  }
}

function Leaderboard({
  stats,
  notes,
  periodLabel,
}: {
  stats: BrandStats[];
  notes?: Map<string, RowNote>;
  periodLabel: string;
}) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: "followers",
    desc: true,
  });
  const rows = useMemo(() => {
    const dir = sort.desc ? -1 : 1;
    return [...stats].sort((a, b) => {
      const va = sortValue(a, sort.key);
      const vb = sortValue(b, sort.key);
      // Missing values always go last, whichever way the column is sorted.
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }, [stats, sort]);

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <h2>Leaderboard</h2>
        <span className="card-sub">
          {periodLabel.charAt(0).toUpperCase() + periodLabel.slice(1)} · click a
          column to sort
        </span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((c) => {
                const active = sort.key === c.key;
                return (
                  <th
                    key={c.key}
                    className={c.left ? "left" : undefined}
                    aria-sort={
                      active
                        ? sort.desc
                          ? "descending"
                          : "ascending"
                        : undefined
                    }
                  >
                    <button
                      onClick={() =>
                        setSort(
                          active
                            ? { key: c.key, desc: !sort.desc }
                            : {
                                key: c.key,
                                desc: !["name", "topTheme"].includes(c.key),
                              },
                        )
                      }
                    >
                      {c.label}
                      <span className="arrow" aria-hidden>
                        {active ? (sort.desc ? "↓" : "↑") : ""}
                      </span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr
                key={s.brand.id}
                className={s.brand.is_montra ? "montra" : undefined}
              >
                <td>
                  <div className="page-name">{s.brand.name}</div>
                  <div className="page-seg">
                    {SEGMENT_LABEL[s.brand.segment]}
                  </div>
                </td>
                <td title={notes?.get(s.brand.id)?.followers}>
                  {fmtInt(s.followers)}
                  {notes?.get(s.brand.id)?.followers && (
                    <span className="fn-mark">*</span>
                  )}
                </td>
                <td
                  className={
                    s.growth == null ? "muted" : s.growth >= 0 ? "up" : "down"
                  }
                  title={notes?.get(s.brand.id)?.growth}
                >
                  {s.growth == null
                    ? "—"
                    : `${fmtSigned(s.growth)} (${fmtPct(s.growthPct, 2)})`}
                  {notes?.get(s.brand.id)?.growth && (
                    <span className="fn-mark">†</span>
                  )}
                </td>
                <td>{s.posts}</td>
                <td>{fmtDec(s.postsPerWeek)}</td>
                <td>{fmtDec(s.avgLikes, 0)}</td>
                <td>{fmtDec(s.avgComments, 1)}</td>
                <td>{fmtPct(s.engagementRate, 2)}</td>
                <td className="left">
                  {s.topTheme ? (
                    <span className={`tag${s.brand.is_montra ? " teal" : ""}`}>
                      {s.topTheme}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="left">
                  <Updated brand={s.brand} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {notes && notes.size > 0 && (
        <p className="note muted">
          {[...notes.values()].some((n) => n.followers) &&
            `* No follower count was recorded by the end of this period (follower counts began with the first sync): ${[
              ...new Set(
                [...notes.values()].map((n) => n.followers).filter(Boolean),
              ),
            ].join("; ")}. `}
          {[...notes.values()].some((n) => n.growth) &&
            "† Resonia pages: growth is LinkedIn's new followers from the uploaded Followers exports."}
        </p>
      )}
    </section>
  );
}

function Updated({ brand }: { brand: DashBrand }) {
  const every = brand.sync_every_days;
  return (
    <span>
      {fmtDate(brand.last_synced_at)}{" "}
      <span className={`tag${every > 1 ? " teal" : ""}`}>
        {every > 1 ? `every ${every} days` : "daily"}
      </span>
    </span>
  );
}

// ---------- bars ----------

function Legend() {
  return (
    <div className="legend" aria-hidden>
      <span>
        <span className="swatch" style={{ background: "var(--teal)" }} />
        Resonia
      </span>
      <span>
        <span className="swatch" style={{ background: "var(--comp)" }} />
        Competitors
      </span>
    </div>
  );
}

function BarCard({
  title,
  sub,
  stats,
  value,
  total,
  format,
  tipText,
  bind,
}: {
  title: string;
  sub: string;
  stats: BrandStats[];
  value: (s: BrandStats) => number;
  total: number;
  format: (v: number, total: number) => string;
  tipText: (s: BrandStats, total: number) => string;
  bind: ReturnType<typeof useTip>["bind"];
}) {
  const rows = [...stats].sort(
    (a, b) => value(b) - value(a) || a.brand.name.localeCompare(b.brand.name),
  );
  const max = Math.max(...rows.map(value), 0);
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          <div className="card-sub">{sub}</div>
        </div>
        <Legend />
      </div>
      {total === 0 ? (
        <div className="empty">No posts in this period yet.</div>
      ) : (
        <div className="bars" role="list">
          {rows.map((s) => (
            <div
              key={s.brand.id}
              role="listitem"
              className={`bar-row${s.brand.is_montra ? " montra" : ""}`}
              aria-label={`${s.brand.name}: ${format(value(s), total)}`}
              {...bind(
                <>
                  <b>{s.brand.name}</b>
                  <br />
                  {tipText(s, total)}
                </>,
              )}
            >
              <span className="bar-label">{s.brand.name}</span>
              <span className="bar-track">
                <span
                  className="bar-fill"
                  style={{
                    display: "block",
                    width: max ? `${(value(s) / max) * 100}%` : 0,
                    background: s.brand.is_montra
                      ? "var(--teal)"
                      : "var(--comp)",
                  }}
                />
              </span>
              <span className="bar-value">{format(value(s), total)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- heatmap ----------

function Heatmap({
  stats,
  themes,
  periodLabel,
  bind,
}: {
  stats: BrandStats[];
  themes: string[];
  periodLabel: string;
  bind: ReturnType<typeof useTip>["bind"];
}) {
  const rows = [...stats].sort(
    (a, b) =>
      Number(b.brand.is_montra) - Number(a.brand.is_montra) ||
      b.posts - a.posts ||
      a.brand.name.localeCompare(b.brand.name),
  );
  // Only show themes that appear somewhere in view, but keep themes.json order.
  const used = themes.filter((t) => rows.some((s) => s.themeCounts.get(t)));
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Content mix</h2>
          <div className="card-sub">
            Posts per theme, {periodLabel}. Shade = share of that page&apos;s
            posts.
          </div>
        </div>
        <div className="heat-scale" aria-hidden>
          0% <span className="ramp" /> 100%
        </div>
      </div>
      {used.length === 0 ? (
        <div className="empty">No posts in this period yet.</div>
      ) : (
        <div className="table-scroll">
          <table className="heat">
            <thead>
              <tr>
                <th />
                {used.map((t) => (
                  <th key={t} scope="col">
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={s.brand.id}
                  className={s.brand.is_montra ? "montra" : undefined}
                >
                  <th scope="row">{s.brand.name}</th>
                  {used.map((t) => {
                    const n = s.themeCounts.get(t) ?? 0;
                    const share = s.posts ? n / s.posts : 0;
                    const pct = Math.round(10 + share * 90);
                    return (
                      <td
                        key={t}
                        className={n ? undefined : "zero"}
                        style={
                          n
                            ? {
                                background: `color-mix(in srgb, var(--teal) ${pct}%, var(--surface))`,
                                color: pct > 55 ? "#fff" : "var(--ink)",
                              }
                            : undefined
                        }
                        {...bind(
                          <>
                            <b>{s.brand.name}</b> · {t}
                            <br />
                            {n} of {s.posts} posts ({fmtPct(share, 0)})
                          </>,
                        )}
                      >
                        {n || "·"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- post feed ----------

const PAGE_SIZE = 24;

function Feed({
  posts,
  brands,
  allBrands,
  stats,
  segment,
  range,
  themes,
  canEditThemes,
  migrated,
  onTheme,
  onMarkAd,
  themeError,
  commentsByPost,
  canHandle,
  onHandled,
  hashtag,
  setHashtag,
  liText,
}: {
  posts: DashPost[];
  brands: DashBrand[];
  allBrands: DashBrand[];
  stats: BrandStats[];
  segment: SegmentFilter;
  range: DateRange;
  themes: string[];
  canEditThemes: boolean;
  migrated: boolean;
  onTheme: (post: DashPost, theme: string | null) => void;
  onMarkAd?: (post: DashPost, ad: boolean | null) => void; // signed in, after schema.sql
  themeError: string | null;
  commentsByPost: Map<string, DashComment[]>;
  canHandle: boolean;
  onHandled: (c: DashComment, handled: boolean) => void;
  hashtag: string | null;
  setHashtag: (t: string | null) => void;
  liText: string; // where Resonia impressions and CTR come from
}) {
  const [brand, setBrand] = useState("all");
  const [type, setType] = useState<PostType | "all">("all");
  const [sort, setSort] = useState<"latest" | "top">("latest");
  const [shown, setShown] = useState(PAGE_SIZE);

  // A brand picked earlier may have dropped out of the segment.
  const activeBrand =
    brand !== "all" && brands.some((b) => b.id === brand) ? brand : "all";
  const byId = useMemo(
    () => new Map(allBrands.map((b) => [b.id, b])),
    [allBrands],
  );
  const followers = useMemo(
    () =>
      new Map(
        stats
          .filter((s) => s.followers != null)
          .map((s) => [s.brand.id, s.followers as number]),
      ),
    [stats],
  );
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of posts) {
      if (activeBrand !== "all" && p.brand !== activeBrand) continue;
      const t = postType(p.media);
      m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }, [posts, activeBrand]);

  const list = useMemo(() => {
    const filtered = posts.filter(
      (p) =>
        (activeBrand === "all" || p.brand === activeBrand) &&
        (type === "all" || postType(p.media) === type) &&
        (!hashtag || hashtags(p.text).includes(hashtag)),
    );
    return filtered.sort((a, b) =>
      sort === "latest"
        ? Date.parse(b.posted_at) - Date.parse(a.posted_at)
        : b.likes + b.comments - (a.likes + a.comments) ||
          Date.parse(b.posted_at) - Date.parse(a.posted_at),
    );
  }, [posts, activeBrand, type, sort, hashtag]);

  const visible = list.slice(0, shown);

  function exportCsv() {
    const csv = postsCsv(
      list,
      (id) => byId.get(id)?.name ?? id,
      followers,
      (id) => !!byId.get(id)?.is_montra,
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const who = activeBrand === "all" ? segment : activeBrand;
    a.download = `resonia-pulse-posts_${who}${type === "all" ? "" : `_${type.toLowerCase()}`}_${range.from}_${range.to}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return (
    <section className="card" id="feed">
      <div className="card-head">
        <div>
          <h2>Post feed</h2>
          <div className="card-sub">
            {list.length} posts, {rangePhrase(range)} · Resonia impressions and
            CTR {liText}
            {canEditThemes
              ? " · change a post's theme from its tag"
              : migrated
                ? ""
                : " · re-run supabase/schema.sql to edit themes"}
          </div>
        </div>
        <div className="feed-tools">
          <select
            className="select"
            aria-label="Filter by page"
            value={activeBrand}
            onChange={(e) => {
              setBrand(e.target.value);
              setShown(PAGE_SIZE);
            }}
          >
            <option value="all">All pages</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <div className="seg" role="group" aria-label="Sort posts">
            <button
              aria-pressed={sort === "latest"}
              onClick={() => setSort("latest")}
            >
              Latest
            </button>
            <button
              aria-pressed={sort === "top"}
              onClick={() => setSort("top")}
            >
              Top engagement
            </button>
          </div>
          <button className="btn" onClick={exportCsv} disabled={!list.length}>
            Export CSV
          </button>
        </div>
      </div>

      {hashtag && (
        <div className="banner hashtag-filter" role="status">
          Showing posts with <b>#{hashtag}</b>{" "}
          <button className="more-link" onClick={() => setHashtag(null)}>
            Clear ×
          </button>
        </div>
      )}

      <div className="chips type-chips" role="group" aria-label="Post type">
        {(["all", ...POST_TYPES] as const).map((t) => (
          <button
            key={t}
            className="chip"
            aria-pressed={type === t}
            onClick={() => {
              setType(t);
              setShown(PAGE_SIZE);
            }}
          >
            {t === "all" ? "All types" : t}
            <span className="chip-count">
              {t === "all"
                ? [...typeCounts.values()].reduce((a, b) => a + b, 0)
                : (typeCounts.get(t) ?? 0)}
            </span>
          </button>
        ))}
      </div>

      {themeError && (
        <div className="banner" role="alert">
          {themeError}
        </div>
      )}

      {list.length === 0 ? (
        <div className="empty">No posts match these filters.</div>
      ) : (
        <ul className="post-grid">
          {visible.map((p) => (
            <li key={p.url}>
              <PostCard
                post={p}
                brand={byId.get(p.brand)}
                followers={followers.get(p.brand)}
                themes={themes}
                canEditThemes={canEditThemes}
                onTheme={onTheme}
                onMarkAd={byId.get(p.brand)?.is_montra ? onMarkAd : undefined}
                comments={
                  byId.get(p.brand)?.track_comments
                    ? (commentsByPost.get(p.url) ?? [])
                    : null
                }
                canHandle={canHandle}
                onHandled={onHandled}
                liText={liText}
              />
            </li>
          ))}
        </ul>
      )}
      {shown < list.length && (
        <div className="feed-foot">
          <button
            className="btn"
            onClick={() => setShown((n) => n + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, list.length - shown)} more
          </button>
        </div>
      )}
    </section>
  );
}

const AUTO_THEME = "__auto";

function PostCard({
  post: p,
  brand: b,
  followers: f,
  themes,
  canEditThemes,
  onTheme,
  onMarkAd,
  comments,
  canHandle,
  onHandled,
  liText,
}: {
  post: DashPost;
  brand: DashBrand | undefined;
  followers: number | undefined;
  themes: string[];
  canEditThemes: boolean;
  onTheme: (post: DashPost, theme: string | null) => void;
  onMarkAd?: (post: DashPost, ad: boolean | null) => void; // Resonia posts, signed in
  comments: DashComment[] | null; // null for pages without comment tracking
  canHandle: boolean;
  onHandled: (c: DashComment, handled: boolean) => void;
  liText: string;
}) {
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const type = postType(p.media);
  const long = p.text.length > 220 || p.text.split("\n").length > 4;
  const er = f ? (p.likes + p.comments) / f : null;
  // Text posts have no image; others keep a placeholder when the thumbnail is missing.
  const showMedia = type !== "Text";

  return (
    <article className={`pcard${b?.is_montra ? " montra" : ""}`}>
      {showMedia && (
        <a
          className="pcard-media"
          href={p.url}
          target="_blank"
          rel="noopener noreferrer"
          tabIndex={-1}
          aria-hidden
        >
          {p.image && !broken ? (
            <img
              src={p.image}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setBroken(true)}
            />
          ) : (
            <span className="pcard-noimg">No image saved</span>
          )}
        </a>
      )}
      <div className="pcard-body">
        <div className="pcard-head">
          <span className="post-brand">{b?.name ?? p.brand}</span>
          <time className="pcard-time" dateTime={p.posted_at}>
            {fmtPostTime(p.posted_at)}
          </time>
        </div>
        <div className="pcard-tags">
          <span className={`badge badge-${type.toLowerCase()}`}>{type}</span>
          <OriginTag post={p} />
          {canEditThemes ? (
            <label
              className={`theme-pick${b?.is_montra ? " teal" : ""}${p.theme_manual ? " manual" : ""}`}
            >
              <span className="sr-only">Theme for this post</span>
              <select
                value={p.theme}
                title={
                  p.theme_manual
                    ? "Theme set by hand (kept by npm run retag)"
                    : "Theme from keyword rules. Change it here."
                }
                onChange={(e) =>
                  onTheme(
                    p,
                    e.target.value === AUTO_THEME ? null : e.target.value,
                  )
                }
              >
                {themes.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
                {p.theme_manual && (
                  <option value={AUTO_THEME}>↺ Back to keyword rules</option>
                )}
              </select>
              {p.theme_manual && <span className="manual-mark">edited</span>}
            </label>
          ) : (
            <span className={`tag${b?.is_montra ? " teal" : ""}`}>
              {p.theme}
            </span>
          )}
        </div>
        <p className={`post-text${open ? " open" : ""}`}>
          {p.text || <em className="muted">(no text)</em>}
        </p>
        {long && (
          <button className="more-link" onClick={() => setOpen((o) => !o)}>
            {open ? "Show less" : "Show more"}
          </button>
        )}
        <div className="pcard-stats">
          <span>
            <strong>{fmtInt(p.likes)}</strong>{" "}
            {p.likes === 1 ? "like" : "likes"}
          </span>
          <span>
            <strong>{fmtInt(p.comments)}</strong>{" "}
            {p.comments === 1 ? "comment" : "comments"}
          </span>
          <span>
            <strong>{fmtInt(p.reposts)}</strong>{" "}
            {p.reposts === 1 ? "repost" : "reposts"}
          </span>
        </div>
        <ReachLine post={p} montra={!!b?.is_montra} label={liText} />
        <div className="pcard-foot">
          <span className="muted">
            {er != null
              ? `${fmtPct(er, er < 0.0001 ? 3 : 2)} per follower · `
              : ""}
            as of {fmtDate(p.as_of)}
          </span>
          <a href={p.url} target="_blank" rel="noopener noreferrer">
            View post ↗
          </a>
        </div>
        {onMarkAd && (
          <div className="pcard-foot">
            <span className="muted small">
              {p.adManual ? "Marked organic by hand" : "On the feed: organic"}
            </span>
            <span>
              {p.adManual && (
                <button className="more-link" onClick={() => onMarkAd(p, null)}>
                  Back to automatic
                </button>
              )}{" "}
              <button
                className="more-link"
                onClick={() => onMarkAd(p, true)}
                title="A paid ad that never appeared on the feed: moves it to the Reach card's Paid ads list"
              >
                Mark as ad
              </button>
            </span>
          </div>
        )}
        {comments && (
          <PostComments
            comments={comments}
            total={p.comments}
            canHandle={canHandle}
            onHandled={onHandled}
          />
        )}
      </div>
    </article>
  );
}
