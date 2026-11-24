"use client";

import { useEffect, useMemo, useState } from "react";
import { RangePicker } from "@/app/RangePicker";
import { LiLabelContext, OriginTag, ReachLine } from "@/app/Reach";
import { liLabel } from "@/lib/reach";
import type { DashboardData, DashXPost } from "@/lib/dashboard";
import { SEGMENT_FILTERS, fmtInt, fmtPostTime, inSegment, istDay, postType, type SegmentFilter } from "@/lib/metrics";
import { download } from "@/lib/orm";
import { fmtRange, rangeQuery, type DateRange } from "@/lib/range";
import {
  TOP_N,
  TOP_RANKS,
  TOP_SEGMENTS,
  fmtRate,
  topByPage,
  topCsv,
  topPagesText,
  topPosts,
  topText,
  topXPosts,
  type PageTop,
  type TopPost,
  type TopRank,
} from "@/lib/top";

export type TopView = "overall" | "pages";
const VIEWS: { id: TopView; label: string }[] = [
  { id: "overall", label: "Overall" },
  { id: "pages", label: "By page" },
];
const COLLAPSED = 3; // competitor blocks in the By page view show this many until expanded

export default function TopPosts({
  data,
  initialRange,
  initialView = "overall",
  initialPage = null,
}: {
  data: DashboardData;
  initialRange: DateRange;
  initialView?: TopView;
  initialPage?: string | null;
}) {
  const today = istDay(data.generatedAt);
  const [range, setRange] = useState(initialRange);
  const [by, setBy] = useState<TopRank>("engagement");
  const [segment, setSegmentState] = useState<SegmentFilter>("all");
  const [view, setView] = useState<TopView>(initialPage ? "pages" : initialView);
  // One page picked from the dropdown (By page view), or null for all pages.
  const [page, setPage] = useState<string | null>(
    initialPage && data.brands.some((b) => b.id === initialPage) ? initialPage : null,
  );
  const [copied, setCopied] = useState<string | null>(null);

  const segBrands = data.brands.filter((b) => inSegment(b, segment));
  const picked = view === "pages" && page ? (segBrands.find((b) => b.id === page) ?? null) : null;
  const setSegment = (s: SegmentFilter) => {
    setSegmentState(s);
    // A picked page outside the new segment would vanish; go back to all pages.
    if (page && !data.brands.some((b) => b.id === page && inSegment(b, s))) setPage(null);
  };
  const pickPage = (id: string) => {
    setPage(id || null);
    if (id) setView("pages");
  };

  // Range, view and picked page live in the page link; an older range than the data loaded
  // reloads stored data.
  useEffect(() => {
    const url = `/top?${rangeQuery(range)}${view === "pages" ? "&view=pages" : ""}${picked ? `&page=${encodeURIComponent(picked.id)}` : ""}`;
    try {
      if (range.from < istDay(data.loadedSince)) window.location.assign(url);
      else window.history.replaceState(null, "", url);
    } catch {
      // ignore
    }
  }, [range, view, picked, data.loadedSince]);

  const top = useMemo(
    () => topPosts(data.posts, data.brands, data.followers, range, { segment, by }),
    [data, range, segment, by],
  );
  const byPage = useMemo(() => {
    const t = topByPage(data.posts, data.brands, data.followers, range, { segment, by });
    if (!picked) return t;
    const only = (list: PageTop[]) => list.filter((p) => p.brand.id === picked.id);
    return { montra: only(t.montra), competitors: only(t.competitors) };
  }, [data, range, segment, by, picked]);
  const x = useMemo(() => (data.x.ready ? topXPosts(data.x.posts, range) : null), [data.x, range]);
  const showX = x && !picked;
  const label = fmtRange(range);
  const segmentLabel = SEGMENT_FILTERS.find((s) => s.id === segment)?.label ?? "All";
  const textOpts = { label, by, segmentLabel, handle: data.x.handle };
  const fileTag = picked ? `_${picked.id}` : view === "pages" ? "_by-page" : "";

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        view === "pages" ? topPagesText(byPage, showX ? x : null, textOpts) : topText(top, x, textOpts),
      );
      setCopied("Copied");
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(null), 2500);
  }

  return (
    <LiLabelContext.Provider value={liLabel(data.liExport)}>
      <div className="wrap">
        <header className="header">
          <div>
            <div className="eyebrow">
              <a href={`/?${rangeQuery(range)}`}>← Dashboard</a> ·{" "}
              <a href={`/digest?${rangeQuery(range)}`}>ORM digest</a> ·{" "}
              <a href={`/report?${rangeQuery(range)}`}>Report</a>
            </div>
            <h1>
              Top <span className="accent">posts</span>
            </h1>
          </div>
          <div className="sync digest-tools">
            <button className="btn" onClick={copy}>
              {copied ?? "Copy as text"}
            </button>
            <button
              className="btn"
              onClick={() =>
                download(
                  `resonia-top-posts${fileTag}_${range.from}_${range.to}.csv`,
                  view === "pages" ? topCsv(byPage, showX ? x : null, data.x.handle) : topCsv(top, x, data.x.handle),
                )
              }
            >
              Export CSV
            </button>
          </div>
        </header>

        <div className="range-bar">
          <RangePicker range={range} today={today} onChange={setRange} />
          <span className="muted">{label} (IST)</span>
        </div>

        <div className="filters top-filters">
          <div className="seg" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button key={v.id} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
                {v.label}
              </button>
            ))}
          </div>
          <select
            className="select"
            aria-label="Page"
            value={picked?.id ?? ""}
            onChange={(e) => pickPage(e.target.value)}
          >
            <option value="">All pages</option>
            {[true, false].map((montra) => (
              <optgroup key={String(montra)} label={montra ? "Resonia" : "Competitors"}>
                {segBrands
                  .filter((b) => b.is_montra === montra)
                  .map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <div className="seg" role="group" aria-label="Rank by">
            {TOP_RANKS.map((r) => (
              <button key={r.id} aria-pressed={by === r.id} onClick={() => setBy(r.id)}>
                {r.label}
              </button>
            ))}
          </div>
          <div className="chips" role="group" aria-label="Segment">
            {SEGMENT_FILTERS.filter((s) => TOP_SEGMENTS.includes(s.id)).map((s) => (
              <button key={s.id} className="chip" aria-pressed={segment === s.id} onClick={() => setSegment(s.id)}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <p className="coverage">
          Top {TOP_N} posts {view === "pages" ? (picked ? `of ${picked.name} ` : "per page ") : ""}published{" "}
          {range.from === range.to ? "on" : "in"} {label}, ranked by{" "}
          {by === "rate" ? "engagement rate: (likes + comments) ÷ page followers" : "likes + comments"}. Likes and
          comments are as of the last sync of each post. Resonia impressions and CTR {liLabel(data.liExport)};
          competitors&apos; are not public.
          {data.trackingSince &&
            ` Tracking started ${fmtRange({ from: istDay(data.trackingSince), to: istDay(data.trackingSince) })}; earlier periods only have each page's latest posts.`}
        </p>

        {view === "overall" ? (
          <div className="grid-2">
            <TopList title="Resonia" list={top.montra} montra />
            <TopList title="Competitors" list={top.competitors} />
          </div>
        ) : (
          <>
            <PageGroup title="Resonia" pages={byPage.montra} montra single={!!picked} />
            <PageGroup title="Competitors" pages={byPage.competitors} single={!!picked} />
          </>
        )}

        {showX && (
          <section className="card">
            <div className="card-head">
              <div>
                <h2>
                  X <span className="tag x">@{data.x.handle}</span>
                </h2>
                <div className="card-sub">
                  Our top {TOP_N} posts by views · engagement is refreshed daily for our latest 5 posts
                </div>
              </div>
              <a href={data.x.profileUrl} target="_blank" rel="noopener noreferrer">
                Open on X ↗
              </a>
            </div>
            {x.length === 0 ? (
              <div className="empty">No X posts in this period.</div>
            ) : (
              <ol className="top-list">
                {x.map((p, i) => (
                  <XRow key={p.id} p={p} rank={i + 1} />
                ))}
              </ol>
            )}
          </section>
        )}
      </div>
    </LiLabelContext.Provider>
  );
}

function PageGroup({
  title,
  pages,
  montra = false,
  single,
}: {
  title: string;
  pages: PageTop[];
  montra?: boolean;
  single: boolean;
}) {
  if (!pages.length) return null;
  return (
    <section className="page-group" aria-label={title}>
      {!single && (
        <h2 className="page-group-title">
          {title}{" "}
          <span className="muted">
            · {pages.length} {pages.length === 1 ? "page" : "pages"}
          </span>
        </h2>
      )}
      <div className={single ? undefined : "grid-2"}>
        {pages.map((p) => (
          <PageBlock key={p.brand.id} page={p} montra={montra} collapse={!montra && !single} />
        ))}
      </div>
    </section>
  );
}

function PageBlock({ page, montra, collapse }: { page: PageTop; montra: boolean; collapse: boolean }) {
  const [open, setOpen] = useState(false);
  const list = collapse && !open ? page.list.slice(0, COLLAPSED) : page.list;
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="page-block-title">{page.brand.name}</h3>
        <a className="card-sub" href={page.brand.linkedin_url} target="_blank" rel="noopener noreferrer">
          Page ↗
        </a>
      </div>
      {page.list.length === 0 ? (
        <div className="empty">No posts in this period</div>
      ) : (
        <ol className="top-list">
          {list.map((r, i) => (
            <TopRow key={r.post.url} r={r} rank={i + 1} montra={montra} />
          ))}
        </ol>
      )}
      {collapse && page.list.length > COLLAPSED && (
        <button className="more-link top-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Show top 3" : `Show all ${page.list.length}`}
        </button>
      )}
    </section>
  );
}

function TopList({ title, list, montra = false }: { title: string; list: TopPost[]; montra?: boolean }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className="card-sub">All tracked platforms</span>
      </div>
      {list.length === 0 ? (
        <div className="empty">No posts in this period.</div>
      ) : (
        <ol className="top-list">
          {list.map((r, i) => (
            <TopRow key={r.post.url} r={r} rank={i + 1} montra={montra} />
          ))}
        </ol>
      )}
    </section>
  );
}

function TopRow({ r, rank, montra }: { r: TopPost; rank: number; montra: boolean }) {
  const [broken, setBroken] = useState(false);
  const p = r.post;
  const type = postType(p.media);
  return (
    <li className="top-item">
      <span className="top-rank">{rank}</span>
      <a className="top-thumb" href={p.url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden>
        {p.image && !broken ? (
          <img src={p.image} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        ) : (
          <span className="pcard-noimg">{type === "Text" ? "Text post" : "No image"}</span>
        )}
      </a>
      <div className="top-body">
        <div className="pcard-head">
          <span className="post-brand">{r.brand.name}</span>
          <time className="pcard-time" dateTime={p.posted_at}>
            {fmtPostTime(p.posted_at)}
          </time>
        </div>
        <div className="pcard-tags">
          <span className={`tag${montra ? " teal" : ""}`}>{p.theme}</span>
          <OriginTag post={p} />
        </div>
        <p className="post-text top-text">{p.text || <em className="muted">(no text)</em>}</p>
        <div className="pcard-stats">
          <span>
            <strong>{fmtInt(p.likes)}</strong> {p.likes === 1 ? "like" : "likes"}
          </span>
          <span>
            <strong>{fmtInt(p.comments)}</strong> {p.comments === 1 ? "comment" : "comments"}
          </span>
          <span>
            <strong>{fmtInt(p.reposts)}</strong> {p.reposts === 1 ? "repost" : "reposts"}
          </span>
          <span title="(likes + comments) ÷ page followers">
            <strong>{fmtRate(r.rate)}</strong> per follower
          </span>
        </div>
        <ReachLine post={p} montra={r.brand.is_montra} />
        <a className="top-link" href={p.url} target="_blank" rel="noopener noreferrer">
          View post ↗
        </a>
      </div>
    </li>
  );
}

function XRow({ p, rank }: { p: DashXPost; rank: number }) {
  return (
    <li className="top-item top-item-x">
      <span className="top-rank">{rank}</span>
      <div className="top-body">
        <div className="pcard-head">
          <span className="post-brand">Resonia</span>
          {p.posted_at && (
            <time className="pcard-time" dateTime={p.posted_at}>
              {fmtPostTime(p.posted_at)}
            </time>
          )}
        </div>
        <p className="post-text top-text">{p.text}</p>
        <div className="pcard-stats">
          <span>
            <strong>{p.views == null ? "—" : fmtInt(p.views)}</strong> {p.views === 1 ? "view" : "views"}
          </span>
          <span>
            <strong>{fmtInt(p.likes)}</strong> {p.likes === 1 ? "like" : "likes"}
          </span>
          <span>
            <strong>{fmtInt(p.replies)}</strong> {p.replies === 1 ? "reply" : "replies"}
          </span>
          <span>
            <strong>{fmtInt(p.reposts)}</strong> {p.reposts === 1 ? "repost" : "reposts"}
          </span>
        </div>
        <a className="top-link" href={p.url} target="_blank" rel="noopener noreferrer">
          Open on X ↗
        </a>
      </div>
    </li>
  );
}
