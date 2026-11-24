"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { DashBrand } from "@/lib/dashboard";
import {
  DAYS,
  FORMATS,
  LOW_DATA,
  OVER,
  UNDER,
  bestSlots,
  fmtSlot,
  formatPerf,
  hashtagStats,
  themePerf,
  timeGrid,
  type Agg,
  type Flag,
  type Highlight,
  type HighlightKind,
} from "@/lib/insights";
import { fmtDec, fmtPct } from "@/lib/metrics";
import type { TopPost } from "@/lib/top";

const fmtAvg = (a: Agg) => (a.avg == null ? "—" : fmtDec(a.avg, a.avg < 10 ? 1 : 0));
const fmtER = (a: Agg) => (a.rate == null ? "—" : fmtPct(a.rate, a.rate < 0.001 ? 3 : 2));

// Any figure from fewer than 5 posts carries this label.
export function LowData({ a }: { a: Pick<Agg, "n" | "low"> }) {
  if (!a.n || !a.low) return null;
  return (
    <span className="low-data" title={`Based on ${a.n} ${a.n === 1 ? "post" : "posts"} (fewer than ${LOW_DATA})`}>
      low data
    </span>
  );
}

// Theme and hashtag results resting mostly on posts from a LinkedIn export (opening text only).
export function PartialText({ a }: { a: Pick<Agg, "n" | "partial"> }) {
  if (!a.n || !a.partial) return null;
  return (
    <span
      className="low-data partial-text"
      title="Most of these posts are known only from a LinkedIn export, which has just their opening text"
    >
      partial text
    </span>
  );
}

export function InsightsTab({
  rows,
  brands,
  themes,
  periodLabel,
  contentMix,
  onHashtag,
  reach,
  children,
}: {
  rows: TopPost[]; // posts in the range on the segment's pages
  brands: DashBrand[]; // the segment's pages
  themes: string[];
  periodLabel: string;
  contentMix: ReactNode;
  onHashtag: (tag: string) => void;
  reach?: ReactNode; // reach and engagement from LinkedIn exports, shown first
  children?: ReactNode; // earned vs owned and the post growth curve
}) {
  return (
    <>
      {reach}
      <p className="coverage">
        Averages are likes + comments per post, {periodLabel}; engagement rate is (likes + comments) ÷ page followers.
        &ldquo;Low data&rdquo; marks figures based on fewer than {LOW_DATA} posts.
      </p>
      <BestTime rows={rows} brands={brands} />
      <FormatCard rows={rows} />
      <div className="grid-2">
        <ThemeCard rows={rows} themes={themes} />
        {contentMix}
      </div>
      <HashtagCard rows={rows} brands={brands} onHashtag={onHashtag} />
      {children}
    </>
  );
}

// ---------- best time to post ----------

function BestTime({ rows, brands }: { rows: TopPost[]; brands: DashBrand[] }) {
  const [who, setWho] = useState<string>("montra"); // "montra", "comp" or a page id
  const page = brands.find((b) => b.id === who);
  const active = page ? who : who === "comp" ? "comp" : "montra";
  const shown = useMemo(
    () =>
      rows.filter((r) =>
        active === "montra" ? r.brand.is_montra : active === "comp" ? !r.brand.is_montra : r.brand.id === active,
      ),
    [rows, active],
  );
  const grid = useMemo(() => timeGrid(shown), [shown]);
  const best = useMemo(() => bestSlots(timeGrid(rows.filter((r) => r.brand.is_montra))), [rows]);
  const max = Math.max(0, ...grid.flat().map((s) => s.avg ?? 0));
  const hours = Array.from({ length: 24 }, (_, h) => h);

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Best time to post</h2>
          <div className="card-sub">
            Average likes + comments per post by day and hour posted (IST) · {shown.length} posts
          </div>
        </div>
        <div className="feed-tools">
          <div className="seg" role="group" aria-label="Whose posts">
            <button aria-pressed={active === "montra"} onClick={() => setWho("montra")}>
              Resonia
            </button>
            <button aria-pressed={active === "comp"} onClick={() => setWho("comp")}>
              Competitors
            </button>
          </div>
          <select
            className="select"
            aria-label="Single page"
            value={page ? page.id : ""}
            onChange={(e) => setWho(e.target.value || "montra")}
          >
            <option value="">Single page…</option>
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="best-slots">
        <span className="kpi-label">Resonia&apos;s best slots</span>
        {best.length === 0 ? (
          <span className="muted">No Resonia posts in this period.</span>
        ) : (
          <ol>
            {best.map((s) => (
              <li key={`${s.day}-${s.hour}`}>
                <b>{fmtSlot(s)}</b> · {fmtAvg(s)} avg · {s.n} {s.n === 1 ? "post" : "posts"} <LowData a={s} />
              </li>
            ))}
          </ol>
        )}
      </div>

      {shown.length === 0 ? (
        <div className="empty">No posts in this period.</div>
      ) : (
        <div className="table-scroll">
          <table className="heat time-grid">
            <thead>
              <tr>
                <th />
                {hours.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.map((row, d) => (
                <tr key={d}>
                  <th scope="row">{DAYS[d]}</th>
                  {row.map((s) => {
                    if (!s.n) return <td key={s.hour} className="zero" />;
                    const pct = Math.round(15 + ((s.avg ?? 0) / (max || 1)) * 85);
                    return (
                      <td
                        key={s.hour}
                        className={s.low ? "low" : undefined}
                        style={{
                          background: `color-mix(in srgb, var(--teal) ${pct}%, var(--surface))`,
                          color: pct > 55 ? "#fff" : "var(--ink)",
                        }}
                        title={`${fmtSlot(s)} IST: ${fmtAvg(s)} likes + comments on average over ${s.n} ${
                          s.n === 1 ? "post" : "posts"
                        }${s.low ? " (low data)" : ""}`}
                      >
                        {fmtAvg(s)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="note muted">
        Hours are the hour a post went out (0 = midnight to 1am IST). Posts known only from a LinkedIn export are left
        out (the export has no posting time). Faded, striped cells are low data (fewer than {LOW_DATA} posts); hover a
        cell for the numbers.
      </p>
    </section>
  );
}

// ---------- format performance ----------

function AggCells({ a, flag, partial = false }: { a: Agg; flag?: Flag; partial?: boolean }) {
  return (
    <>
      <td className={flag === "over" ? "up" : flag === "under" ? "down" : a.n ? undefined : "muted"}>
        {flag === "over" ? "▲ " : flag === "under" ? "▼ " : ""}
        {fmtAvg(a)}
      </td>
      <td className={a.n ? undefined : "muted"}>{fmtER(a)}</td>
      <td className={a.n ? undefined : "muted"}>
        {a.n} <LowData a={a} /> {partial && <PartialText a={a} />}
      </td>
    </>
  );
}

function SideHead({ first }: { first: string }) {
  return (
    <thead>
      <tr>
        <th className="left" rowSpan={2}>
          {first}
        </th>
        <th colSpan={3} className="side-head montra-head">
          Resonia
        </th>
        <th colSpan={3} className="side-head">
          Competitors
        </th>
      </tr>
      <tr>
        <th>Avg L+C</th>
        <th>Eng. rate</th>
        <th>Posts</th>
        <th>Avg L+C</th>
        <th>Eng. rate</th>
        <th>Posts</th>
      </tr>
    </thead>
  );
}

function FormatCard({ rows }: { rows: TopPost[] }) {
  const f = useMemo(() => formatPerf(rows), [rows]);
  const pages = [...f.pages].sort(
    (a, b) => Number(b.brand.is_montra) - Number(a.brand.is_montra) || a.brand.name.localeCompare(b.brand.name),
  );
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Format performance</h2>
          <div className="card-sub">Image, video, document/carousel and text posts, Resonia vs competitors</div>
        </div>
      </div>
      <div className="table-scroll">
        <table className="perf">
          <SideHead first="Format" />
          <tbody>
            {f.overall.map((x) => (
              <tr key={x.key}>
                <td>{x.key}</td>
                <AggCells a={x.montra} />
                <AggCells a={x.comp} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 className="digest-h3">By page</h3>
      {pages.length === 0 ? (
        <div className="empty">No posts in this period.</div>
      ) : (
        <div className="table-scroll">
          <table className="perf">
            <thead>
              <tr>
                <th className="left">Page</th>
                {FORMATS.map((fm) => (
                  <th key={fm}>{fm}</th>
                ))}
                <th>All posts</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((p) => (
                <tr key={p.brand.id} className={p.brand.is_montra ? "montra" : undefined}>
                  <td>
                    <div className="page-name">{p.brand.name}</div>
                  </td>
                  {[...FORMATS.map((fm) => p.byFormat.get(fm)!), p.all].map((a, i) => (
                    <td key={i} className={a.n ? undefined : "muted"}>
                      {a.n ? (
                        <>
                          {fmtAvg(a)}{" "}
                          <span className="muted">
                            · {fmtER(a)} · {a.n}
                          </span>{" "}
                          <LowData a={a} />
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="note muted">By page: average likes + comments · engagement rate · posts.</p>
    </section>
  );
}

// ---------- theme performance ----------

function ThemeCard({ rows, themes }: { rows: TopPost[]; themes: string[] }) {
  const t = useMemo(() => themePerf(rows, themes), [rows, themes]);
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Theme performance</h2>
          <div className="card-sub">Average likes + comments and engagement rate by theme</div>
        </div>
      </div>
      {t.themes.length === 0 ? (
        <div className="empty">No posts in this period.</div>
      ) : (
        <div className="table-scroll">
          <table className="perf">
            <SideHead first="Theme" />
            <tbody>
              {t.themes.map((x) => (
                <tr key={x.key}>
                  <td>{x.key}</td>
                  <AggCells a={x.montra} flag={x.montraFlag} partial />
                  <AggCells a={x.comp} flag={x.compFlag} partial />
                </tr>
              ))}
              <tr className="perf-total">
                <td>All themes</td>
                <AggCells a={t.montra} />
                <AggCells a={t.comp} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="note muted">
        <span className="up">▲</span> {Math.round((OVER - 1) * 100)}%+ above or <span className="down">▼</span>{" "}
        {Math.round((1 - UNDER) * 100)}%+ below the average for all of that side&apos;s posts (the &ldquo;All
        themes&rdquo; row). Low-data themes are never flagged.
      </p>
    </section>
  );
}

// ---------- hashtags ----------

function HashtagCard({
  rows,
  brands,
  onHashtag,
}: {
  rows: TopPost[];
  brands: DashBrand[];
  onHashtag: (tag: string) => void;
}) {
  const h = useMemo(() => hashtagStats(rows), [rows]);
  const tag = (t: string) => (
    <button className="tag-btn" onClick={() => onHashtag(t)} title={`Show posts with #${t} in the post feed`}>
      #{t}
    </button>
  );
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Hashtag tracker</h2>
          <div className="card-sub">
            How often each hashtag is used and the average likes + comments on posts using it. Click a hashtag to filter
            the post feed.
          </div>
        </div>
      </div>
      {h.overall.length === 0 ? (
        <div className="empty">No hashtags in this period.</div>
      ) : (
        <div className="table-scroll">
          <table className="perf">
            <thead>
              <tr>
                <th className="left">Hashtag</th>
                <th>Posts</th>
                <th>Pages</th>
                <th>Avg L+C</th>
                <th>Eng. rate</th>
              </tr>
            </thead>
            <tbody>
              {h.overall.slice(0, 15).map((t) => (
                <tr key={t.tag}>
                  <td>{tag(t.tag)}</td>
                  <td>{t.uses}</td>
                  <td>{t.pages}</td>
                  <td>
                    {fmtAvg(t)} <LowData a={t} /> <PartialText a={t} />
                  </td>
                  <td>{fmtER(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 className="digest-h3">Top hashtags per page</h3>
      <div className="tag-pages">
        {brands.map((b) => {
          const list = (h.perPage.get(b.id) ?? []).slice(0, 5);
          return (
            <div key={b.id} className={`tag-page${b.is_montra ? " montra" : ""}`}>
              <div className="page-name">{b.name}</div>
              {list.length === 0 ? (
                <div className="muted">No hashtags in this period</div>
              ) : (
                <ul>
                  {list.map((t) => (
                    <li key={t.tag}>
                      {tag(t.tag)}{" "}
                      <span className="muted">
                        ×{t.uses} · {fmtAvg(t)} avg
                      </span>{" "}
                      <LowData a={t} /> <PartialText a={t} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------- Overview highlights ----------

const KIND_LABEL: Record<HighlightKind, string> = {
  launch: "Launch / price",
  spike: "Standout post",
  volume: "Posting spike",
  followers: "Follower jump",
};

export function Highlights({ items, periodLabel }: { items: Highlight[]; periodLabel: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 6);
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>Highlights</h2>
          <div className="card-sub">
            Automatic callouts, {periodLabel}: launch and price posts by competitors, standout posts, posting spikes and
            follower jumps
          </div>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="empty">Nothing stands out in this period.</div>
      ) : (
        <ul className="highlights">
          {shown.map((h, i) => (
            <li key={i} className={h.brand.is_montra ? "montra" : undefined}>
              <span className={`hl-kind hl-${h.kind}`}>{KIND_LABEL[h.kind]}</span>
              <span className="hl-text">
                {h.text}
                {h.url && (
                  <>
                    {" "}
                    <a href={h.url} target="_blank" rel="noopener noreferrer">
                      View post ↗
                    </a>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {items.length > 6 && (
        <button className="more-link" onClick={() => setAll((a) => !a)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}
