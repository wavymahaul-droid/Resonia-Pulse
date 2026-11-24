"use client";

import { useEffect, useMemo, useState } from "react";
import { CommentItem, XStats, useHandled } from "@/app/Comments";
import { RangePicker } from "@/app/RangePicker";
import type { DigestData } from "@/lib/dashboard";
import { fmtDate, fmtInt, fmtPostTime, fmtSigned, istDay } from "@/lib/metrics";
import { SENTIMENT_ORDER, commentDay, commentsCsv, digest, digestText, download } from "@/lib/orm";
import { customRange, fmtRange, inRange, rangeQuery, stepRange, type DateRange } from "@/lib/range";

const SENT_COLOR: Record<string, string> = {
  Negative: "var(--bad)",
  Lead: "var(--lead)",
  Question: "var(--question)",
  Careers: "var(--careers)",
  Positive: "var(--good)",
  Neutral: "var(--comp)",
  Spam: "var(--spam)",
};

export default function Digest({ data, initialRange }: { data: DigestData; initialRange: DateRange }) {
  const today = istDay(data.generatedAt);
  const [range, setRange] = useState(initialRange);
  const [copied, setCopied] = useState<string | null>(null);
  // Spam is left out of the digest unless asked for.
  const [includeSpam, setIncludeSpam] = useState(false);
  // Marking handled here needs sign-in, which the public view never has.
  const handled = useHandled(data.comments);
  const canHandle = !data.publicView;

  // Keep the range in the link so it can be shared. A range older than the data the server
  // loaded reloads the page (stored data only, no new scrapes).
  useEffect(() => {
    const url = `/digest?${rangeQuery(range)}`;
    try {
      if (range.from < istDay(data.loadedSince)) window.location.assign(url);
      else window.history.replaceState(null, "", url);
    } catch {
      // ignore
    }
  }, [range, data.loadedSince]);

  const d = useMemo(
    () => digest(range, handled.comments, data.posts, data.brands, { includeSpam, x: data.x }),
    [range, handled.comments, data, includeSpam],
  );
  const single = range.from === range.to;
  const shown = SENTIMENT_ORDER.filter((s) => s !== "Spam" || includeSpam);
  const name = (id: string) => data.brands.find((b) => b.id === id)?.name ?? id;
  const label = fmtRange(range);
  const onLabel = `${single ? "on" : "in"} ${label}`;
  const daysWithComments = useMemo(
    () => [...new Set(handled.comments.map(commentDay).filter(Boolean) as string[])].sort().reverse(),
    [handled.comments],
  );

  async function copy() {
    const text = digestText(d, label, name);
    try {
      await navigator.clipboard.writeText(text);
      setCopied("Copied");
    } catch {
      setCopied("Copy failed: select the text below instead");
    }
    setTimeout(() => setCopied(null), 2500);
  }

  return (
    <div className="wrap">
      <header className="header">
        <div>
          <div className="eyebrow">
            <a href={`/?${rangeQuery(range)}`}>← Dashboard</a> · <a href={`/top?${rangeQuery(range)}`}>Top posts</a> · <a href={`/report?${rangeQuery(range)}`}>Report</a> · {data.brands.map((b) => b.name).join(", ")}
          </div>
          <h1>
            ORM <span className="accent">{single ? "daily digest" : "digest"}</span>
          </h1>
        </div>
        <div className="sync digest-tools">
          <button
            className="btn"
            onClick={() => setRange(stepRange(range, -1, today))}
            aria-label={single ? "Previous day" : "Previous period"}
          >
            ←
          </button>
          <RangePicker range={range} today={today} onChange={setRange} />
          <button
            className="btn"
            onClick={() => setRange(stepRange(range, 1, today))}
            disabled={range.to >= today}
            aria-label={single ? "Next day" : "Next period"}
          >
            →
          </button>
          <button className="btn" onClick={copy}>
            {copied ?? "Copy as text"}
          </button>
          <button
            className="btn"
            onClick={() =>
              download(
                single ? `resonia-orm-digest_${range.from}.csv` : `resonia-orm-digest_${range.from}_${range.to}.csv`,
                commentsCsv(
                  handled.comments.filter(
                    (c) => inRange(commentDay(c), range) && (includeSpam || c.sentiment !== "Spam"),
                  ),
                  name,
                ),
              )
            }
          >
            Export CSV
          </button>
          <label className="check">
            <input type="checkbox" checked={includeSpam} onChange={(e) => setIncludeSpam(e.target.checked)} />
            Include spam{d.spam ? ` (${d.spam})` : ""}
          </label>
        </div>
      </header>

      {!data.commentsReady ? (
        <div className="banner">
          Comment tracking starts once supabase/schema.sql has been re-run (it adds the comments table).
        </div>
      ) : (
        <>
          {data.publicView && (
            <p className="coverage">
              Public view: commenter names and contact details are hidden. Team sign-in shows them.
            </p>
          )}
          {d.total === 0 && daysWithComments.length > 0 && (
            <p className="coverage">
              No new comments {onLabel}. Recent days with comments:{" "}
              {daysWithComments.slice(0, 5).map((x, i) => (
                <span key={x}>
                  {i > 0 && ", "}
                  <button className="more-link" onClick={() => setRange(customRange(x, x, today))}>
                    {fmtDate(`${x}T12:00:00+05:30`)}
                  </button>
                </span>
              ))}
            </p>
          )}

          <section className="kpis digest-kpis" aria-label="Summary">
            <div className="card">
              <div className="kpi-label">New comments{data.x.ready ? " & X mentions" : ""}</div>
              <div className="kpi-value">{d.total}</div>
              <div className="kpi-foot">
                {label} (IST), Resonia&apos;s own replies{data.x.ready ? " and X media mentions" : ""} not counted
                {!includeSpam && d.spam ? `, ${d.spam} spam hidden` : ""}
              </div>
            </div>
            <div className="card">
              <div className="kpi-label">Needs response</div>
              <div className="kpi-value">{d.flagged.length}</div>
              <div className="kpi-foot">{d.flagged.filter((c) => !c.handled).length} still open</div>
            </div>
            <div className="card digest-split">
              <div className="kpi-label">Sentiment split</div>
              <div
                className="split-bar"
                role="img"
                aria-label={shown.map((s) => `${s} ${d.bySentiment[s]}`).join(", ")}
              >
                {d.total ? (
                  shown
                    .filter((s) => d.bySentiment[s])
                    .map((s) => <span key={s} style={{ flex: d.bySentiment[s], background: SENT_COLOR[s] }} />)
                ) : (
                  <span style={{ flex: 1, background: "var(--line)" }} />
                )}
              </div>
              <div className="split-legend">
                {shown.map((s) => (
                  <span key={s}>
                    <i style={{ background: SENT_COLOR[s] }} />
                    {s} <b>{d.bySentiment[s]}</b>
                  </span>
                ))}
              </div>
            </div>
          </section>

          <section className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <h2>By page</h2>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="left">Page</th>
                    <th>New</th>
                    {shown.map((s) => (
                      <th key={s}>{s}</th>
                    ))}
                    <th>Needs response</th>
                    <th>Open</th>
                    <th>Resonia replies</th>
                  </tr>
                </thead>
                <tbody>
                  {d.pages.map((p) => (
                    <tr key={p.brand.id}>
                      <td>
                        <div className="page-name">{p.brand.name}</div>
                      </td>
                      <td>{p.total}</td>
                      {shown.map((s) => (
                        <td key={s} className={p.bySentiment[s] ? undefined : "muted"}>
                          {p.bySentiment[s]}
                        </td>
                      ))}
                      <td>{p.flagged}</td>
                      <td className={p.open ? "down" : "muted"}>{p.open}</td>
                      <td>{p.pageReplies}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {d.pages.some((p) => p.total === 0) && (
              <p className="note">
                No new comments {onLabel} for:{" "}
                {d.pages
                  .filter((p) => p.total === 0)
                  .map((p) => p.brand.name)
                  .join(", ")}
                .
              </p>
            )}
          </section>

          <section className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <h2>Most discussed Resonia post</h2>
            </div>
            {d.topPost ? (
              <div className="top-post">
                <div className="muted">
                  {name(d.topPost.post?.brand ?? "")} · {d.topPost.count} new{" "}
                  {d.topPost.count === 1 ? "comment" : "comments"} {onLabel}
                </div>
                <p className="post-text open">{d.topPost.post?.text || "(no text)"}</p>
                <a href={d.topPost.url} target="_blank" rel="noopener noreferrer">
                  View post ↗
                </a>
              </div>
            ) : (
              <div className="empty">No new comments {single ? "on this day" : "in this period"}.</div>
            )}
          </section>

          <section className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
              <div>
                <h2>LinkedIn mentions</h2>
                <div className="card-sub">
                  Public posts by others naming Resonia or EViator {onLabel} ·{" "}
                  {d.liMentions.filter((c) => c.media).length} media,{" "}
                  {d.liMentions.filter((c) => c.li?.staff).length} Resonia team,{" "}
                  {d.liMentions.filter((c) => c.needs_response).length} need a response
                </div>
              </div>
            </div>
            {d.liMentions.length === 0 ? (
              <p className="note muted">No LinkedIn mentions {onLabel}.</p>
            ) : (
              <ul className="cmt-list">
                {d.liMentions.map((c) => (
                  <li key={c.id}>
                    <CommentItem c={c} canHandle={canHandle} onHandled={handled.setHandled} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {d.x && (
            <section className="card" style={{ marginBottom: 16 }}>
              <div className="card-head">
                <div>
                  <h2>
                    X <span className="tag x">@{data.x.handle}</span>
                  </h2>
                  <div className="card-sub">
                    {d.x.followers != null
                      ? `${fmtInt(d.x.followers)} followers${d.x.followerChange != null ? ` (${fmtSigned(d.x.followerChange)} since the previous count)` : ""}`
                      : "Follower count not recorded yet"}{" "}
                    · {d.x.mentions} customer {d.x.mentions === 1 ? "mention" : "mentions"}, {d.x.media.length} media{" "}
                    {d.x.media.length === 1 ? "mention" : "mentions"}, {d.x.replies} Resonia{" "}
                    {d.x.replies === 1 ? "reply" : "replies"} {onLabel}
                  </div>
                </div>
                <a href={data.x.profileUrl} target="_blank" rel="noopener noreferrer">
                  Open on X ↗
                </a>
              </div>
              <h3 className="digest-h3">Our posts</h3>
              {d.x.posts.length === 0 ? (
                <p className="note muted">No posts {onLabel}.</p>
              ) : (
                <ul className="cmt-list">
                  {d.x.posts.map((p) => (
                    <li key={p.id}>
                      <div className="cmt cmt-page">
                        <div className="cmt-head">
                          <span className="cmt-name">Resonia</span>
                          {p.posted_at && <time className="cmt-time">{fmtPostTime(p.posted_at)}</time>}
                        </div>
                        <p className="cmt-text">{p.text}</p>
                        <div className="cmt-foot">
                          <XStats likes={p.likes} replies={p.replies} reposts={p.reposts} />
                          {p.views != null && <span className="muted">{fmtInt(p.views)} views</span>}
                          <span className="cmt-actions">
                            <a href={p.url} target="_blank" rel="noopener noreferrer">
                              Open on X ↗
                            </a>
                          </span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <h3 className="digest-h3">Media mentions</h3>
              {d.x.media.length === 0 ? (
                <p className="note muted">No media mentions {onLabel}.</p>
              ) : (
                <ul className="cmt-list">
                  {d.x.media.map((c) => (
                    <li key={c.id}>
                      <CommentItem c={c} canHandle={canHandle} onHandled={handled.setHandled} />
                    </li>
                  ))}
                </ul>
              )}
              {d.x.placeholders.length > 0 && (
                <>
                  <h3 className="digest-h3">Replies with an unfilled template</h3>
                  <ul className="cmt-list">
                    {d.x.placeholders.map((c) => (
                      <li key={c.id}>
                        <CommentItem c={c} canHandle={canHandle} onHandled={handled.setHandled} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <p className="note muted">
                Customer mentions are in the totals above, in the &ldquo;X @{data.x.handle}&rdquo; row and, when they
                need a response, in the flagged list below.
              </p>
            </section>
          )}

          {d.careers.length > 0 && (
            <section className="card" style={{ marginBottom: 16 }}>
              <div className="card-head">
                <div>
                  <h2>Job seekers</h2>
                  <div className="card-sub">Careers comments {onLabel}: not flagged and not counted as leads</div>
                </div>
              </div>
              <ul className="cmt-list">
                {d.careers.map((c) => (
                  <li key={c.id}>
                    <CommentItem
                      c={c}
                      canHandle={canHandle}
                      onHandled={handled.setHandled}
                      context={{ page: name(c.brand), postUrl: c.post_url }}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card">
            <div className="card-head">
              <div>
                <h2>Flagged comments</h2>
                <div className="card-sub">
                  Negative, Question and Lead comments, LinkedIn mentions{data.x.ready ? " and X mentions" : ""} posted{" "}
                  {onLabel}
                </div>
              </div>
            </div>
            {handled.error && (
              <div className="banner" role="alert">
                {handled.error}
              </div>
            )}
            {d.flagged.length === 0 ? (
              <div className="empty">Nothing needs a response {single ? "for this day" : "in this period"}.</div>
            ) : (
              <ul className="cmt-list">
                {d.flagged.map((c) => (
                  <li key={c.id}>
                    <CommentItem
                      c={c}
                      canHandle={canHandle}
                      onHandled={handled.setHandled}
                      context={{ page: name(c.brand), postUrl: c.post_url }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
