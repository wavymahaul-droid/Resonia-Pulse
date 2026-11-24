"use client";

import { useEffect, useMemo, useState } from "react";
import { LowData } from "@/app/Insights";
import MonthlyReport, { type MonthlyData } from "@/app/MonthlyReport";
import { LiLabelContext, ReachLine } from "@/app/Reach";
import { RangePicker } from "@/app/RangePicker";
import { previousRange } from "@/lib/analytics";
import type { DashboardData } from "@/lib/dashboard";
import { LOW_DATA, fmtSlot } from "@/lib/insights";
import { fmtDate, fmtInt, fmtPostTime, istDay } from "@/lib/metrics";
import { download } from "@/lib/orm";
import { rangeQuery, type DateRange } from "@/lib/range";
import {
  LI_EXPORTS_ENABLED,
  ORM_ENABLED,
  POSTS_BACKFILLED_FROM,
} from "@/lib/brands";
import {
  buildReport,
  fmtChange,
  fmtValue,
  NO_PREV,
  reportCsv,
  reportText,
  trendOf,
  type Metric,
} from "@/lib/report";
import { VIDEO_CTR_NOTE } from "@/lib/reach";
import { fmtRate, type TopPost } from "@/lib/top";

export default function Report({
  data,
  initialRange,
  month,
  monthly,
  signedIn = false,
}: {
  data: DashboardData;
  initialRange: DateRange;
  month: string;
  monthly: MonthlyData;
  signedIn?: boolean;
}) {
  const today = istDay(data.generatedAt);
  const [range, setRange] = useState(initialRange);
  const [copied, setCopied] = useState<string | null>(null);

  // The range lives in the page link. A range whose previous period starts before the data
  // loaded reloads the page (stored data only).
  useEffect(() => {
    const url = `/report?${rangeQuery(range)}&month=${month}`;
    try {
      if (previousRange(range).from < istDay(data.loadedSince))
        window.location.assign(url);
      else window.history.replaceState(null, "", url);
    } catch {
      // ignore
    }
  }, [range, data.loadedSince, month]);

  const r = useMemo(() => buildReport(data, range), [data, range]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(reportText(r));
      setCopied("Copied");
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(null), 2500);
  }

  return (
    <LiLabelContext.Provider value={r.reach.label}>
      <div className="wrap report">
        <header className="header">
          <div>
            <div className="eyebrow">
              <a href={`/?${rangeQuery(range)}`}>← Dashboard</a> ·{" "}
              <a href={`/top?${rangeQuery(range)}`}>Top posts</a> ·{" "}
              <a href={`/digest?${rangeQuery(range)}`}>ORM digest</a>
            </div>
            <h1>
              Resonia <span className="accent">report</span>
            </h1>
            <div className="card-sub">
              {r.label}, compared with the previous {r.prevLabel}
              {r.anyPrev
                ? ", where there is comparable earlier data"
                : ` (${NO_PREV})`}
            </div>
          </div>
          <div className="sync digest-tools">
            <button className="btn" onClick={copy}>
              {copied ?? "Copy as text"}
            </button>
            <button
              className="btn"
              onClick={() =>
                download(
                  `resonia-report_${range.from}_${range.to}.csv`,
                  reportCsv(r),
                )
              }
            >
              Export CSV
            </button>
          </div>
        </header>

        <div className="range-bar">
          <RangePicker range={range} today={today} onChange={setRange} />
        </div>
        {data.publicView && (
          <p className="coverage">
            Public view: names and links of individual people are hidden. Team
            sign-in shows them.
          </p>
        )}

        {LI_EXPORTS_ENABLED && (
          <MonthlyReport
            data={data}
            monthly={monthly}
            month={month}
            today={today}
            signedIn={signedIn}
            onMonth={(m) =>
              window.location.assign(`/report?${rangeQuery(range)}&month=${m}`)
            }
          />
        )}

        <h2 className="report-part">Period report: {r.label}</h2>

        <Section
          title="Key numbers"
          sub="Resonia vs competitors, all tracked platforms"
        >
          <Metrics list={r.kpis} prevLabel={r.prevLabel} />
        </Section>

        {LI_EXPORTS_ENABLED && (
          <Section
            title="New followers per Resonia page"
            sub={`${r.label} · LinkedIn's own figures from the uploaded Followers exports`}
          >
            <div className="table-scroll">
              <table className="perf report-metrics">
                <thead>
                  <tr>
                    <th className="left">Page</th>
                    <th>Organic</th>
                    <th>Sponsored</th>
                    <th>Total</th>
                    <th>Export days</th>
                  </tr>
                </thead>
                <tbody>
                  {r.newFollowers.map((f) => (
                    <tr key={f.page}>
                      <td>{f.page}</td>
                      <td>{f.organic == null ? "—" : fmtInt(f.organic)}</td>
                      <td>{f.sponsored == null ? "—" : fmtInt(f.sponsored)}</td>
                      <td>
                        <b>{f.total == null ? "—" : fmtInt(f.total)}</b>
                      </td>
                      <td className={f.days < f.of ? "down" : "muted"}>
                        {f.days} of {f.of}
                      </td>
                    </tr>
                  ))}
                  <tr className="perf-total">
                    <td>All Resonia pages</td>
                    {(["organic", "sponsored", "total"] as const).map((k) => {
                      const v = r.newFollowers.filter((f) => f[k] != null);
                      return (
                        <td key={k}>
                          {v.length
                            ? fmtInt(
                                v.reduce((a, f) => a + (f[k] as number), 0),
                              )
                            : "—"}
                        </td>
                      );
                    })}
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          </Section>
        )}

        <Section title="Highlights">
          {r.highlights.length === 0 ? (
            <div className="empty">Nothing stood out in this period.</div>
          ) : (
            <ul className="report-list">
              {r.highlights.slice(0, 8).map((h, i) => (
                <li key={i}>
                  {h.text}{" "}
                  {h.url && (
                    <a href={h.url} target="_blank" rel="noopener noreferrer">
                      View ↗
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="grid-2">
          <Section title="Top Resonia posts" sub="By likes + comments">
            <Tops list={r.top.montra} />
          </Section>
          <Section title="Top competitor posts" sub="By likes + comments">
            <Tops list={r.top.competitors} />
          </Section>
        </div>

        {ORM_ENABLED && (
          <Section
            title="Comments and reputation (ORM)"
            sub="Resonia LinkedIn comments, X mentions and LinkedIn mentions"
          >
            <Metrics list={r.orm.metrics} prevLabel={r.prevLabel} />
            <div className="report-sentiment">
              {r.orm.sentiment.map((s) => (
                <span key={s.name}>
                  {s.name} <b>{s.now}</b>{" "}
                  {s.prev != null && (
                    <span className="muted">(was {s.prev})</span>
                  )}
                </span>
              ))}
              {r.orm.sentiment.some((s) => s.prev == null) && (
                <span className="muted">{NO_PREV}</span>
              )}
            </div>
            {r.orm.flagged.length > 0 && (
              <>
                <h3 className="digest-h3">
                  Needing a response ({r.orm.flagged.length})
                </h3>
                <ul className="report-list">
                  {r.orm.flagged.slice(0, 5).map((c) => {
                    const link = c.url ?? (c.channel ? null : c.post_url);
                    return (
                      <li key={c.id}>
                        <span className="muted">
                          {c.channel === "x"
                            ? "X · "
                            : c.channel === "li_mention"
                              ? "LinkedIn mention · "
                              : ""}
                          {c.sentiment}
                          {c.handled ? " · handled" : ""}
                        </span>{" "}
                        {c.name}: &ldquo;
                        {c.text.length > 110
                          ? `${c.text.slice(0, 109)}…`
                          : c.text}
                        &rdquo;{" "}
                        {link && (
                          <a
                            href={link}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Open ↗
                          </a>
                        )}
                      </li>
                    );
                  })}
                  {r.orm.flagged.length > 5 && (
                    <li className="muted">
                      and {r.orm.flagged.length - 5} more
                    </li>
                  )}
                </ul>
              </>
            )}
          </Section>
        )}

        {ORM_ENABLED && (
          <div className="grid-2">
            {r.x.ready && (
              <Section title={`X @${r.x.handle}`}>
                <Metrics list={r.x.metrics} prevLabel={r.prevLabel} />
              </Section>
            )}
            <Section
              title="Earned vs owned"
              sub="Media mentions of Resonia vs Resonia's own posts"
            >
              <Metrics list={r.earned.metrics} prevLabel={r.prevLabel} />
              {r.earned.outlets.length > 0 && (
                <>
                  <h3 className="digest-h3">Media outlets</h3>
                  <ul className="report-list">
                    {r.earned.outlets.slice(0, 8).map((o) => (
                      <li key={`${o.channel}:${o.name}`}>
                        {o.url ? (
                          <a
                            href={o.url}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {o.name} ↗
                          </a>
                        ) : (
                          o.name
                        )}{" "}
                        <span className="muted">
                          ({o.channel}) · {o.count} · last {fmtPostTime(o.last)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Section>
          </div>
        )}

        {r.reach.ready && (
          <Section
            title="Reach and engagement"
            sub={`Resonia LinkedIn pages, ${r.reach.mode.toLowerCase()} page totals ${r.reach.label}; every post on a Resonia feed is organic. ${VIDEO_CTR_NOTE}. Competitors' impressions and clicks are not public; see public interactions under Key numbers.`}
          >
            {r.reach.metrics.every((m) => m.now == null && m.prev == null) ? (
              <div className="empty">
                No LinkedIn analytics uploaded for this period yet.
              </div>
            ) : (
              <Metrics list={r.reach.metrics} prevLabel={r.prevLabel} />
            )}
          </Section>
        )}

        <Section
          title="Best time to post"
          sub="Resonia's best slots by average likes + comments (IST)"
        >
          {r.bestTime.length === 0 ? (
            <div className="empty">No Resonia posts in this period.</div>
          ) : (
            <ol className="report-list">
              {r.bestTime.map((s) => (
                <li key={`${s.day}-${s.hour}`}>
                  <b>{fmtSlot(s)}</b> · {s.avg == null ? "—" : fmtInt(s.avg)}{" "}
                  avg · {s.n} {s.n === 1 ? "post" : "posts"} <LowData a={s} />
                </li>
              ))}
            </ol>
          )}
        </Section>

        <p className="note muted">
          &ldquo;Low data&rdquo; = based on fewer than {LOW_DATA} posts or
          replies. Built from the tracker&apos;s stored data; daily tracking
          started{" "}
          {data.trackingSince ? fmtDate(data.trackingSince, true) : "recently"}{" "}
          and every page&apos;s posts were collected back to{" "}
          {fmtDate(`${POSTS_BACKFILLED_FROM}T12:00:00+05:30`, true)}. A figure
          is only compared with the previous period when that period is fully
          covered (posts from the backfill date; followers, comments, mentions
          and X from when each was first tracked; reach when the LinkedIn export
          has at least 90% of its days); otherwise it says &ldquo;{NO_PREV}
          &rdquo;.
        </p>
      </div>
    </LiLabelContext.Provider>
  );
}

function Section({
  title,
  sub,
  children,
}: {
  title: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {sub && <div className="card-sub">{sub}</div>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Metrics({ list, prevLabel }: { list: Metric[]; prevLabel: string }) {
  return (
    <div className="table-scroll">
      <table className="perf report-metrics">
        <thead>
          <tr>
            <th className="left" />
            <th>This period</th>
            <th>Previous</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {list.map((m) => {
            const c = fmtChange(m);
            const t = trendOf(m);
            return (
              <tr key={m.label}>
                <td>{m.label}</td>
                <td>
                  <b>{fmtValue(m.now, m.format)}</b>{" "}
                  {m.low && <LowData a={{ n: 1, low: true }} />}
                  {m.note && (
                    <div className="muted small metric-note">{m.note}</div>
                  )}
                </td>
                {m.noPrev ? (
                  <td className="muted no-prev" colSpan={2}>
                    {NO_PREV}
                  </td>
                ) : (
                  <>
                    <td className="muted" title={prevLabel}>
                      {fmtValue(m.prev, m.format)}
                    </td>
                    <td
                      className={
                        t === "up" ? "up" : t === "down" ? "down" : "muted"
                      }
                    >
                      {c ?? "—"}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Tops({ list }: { list: TopPost[] }) {
  if (!list.length)
    return <div className="empty">No posts in this period.</div>;
  return (
    <ol className="report-list report-tops">
      {list.map((t) => (
        <li key={t.post.url}>
          <b>{t.brand.name}</b>{" "}
          <span className="muted">· {fmtPostTime(t.post.posted_at)}</span>
          <div className="top-text post-text">{t.post.text || "(no text)"}</div>
          <div className="muted">
            {fmtInt(t.post.likes)} likes · {fmtInt(t.post.comments)} comments ·{" "}
            {fmtInt(t.post.reposts)} reposts · {fmtRate(t.rate)} per follower{" "}
            <a href={t.post.url} target="_blank" rel="noopener noreferrer">
              View post ↗
            </a>
          </div>
          <ReachLine post={t.post} montra={t.brand.is_montra} />
        </li>
      ))}
    </ol>
  );
}
