"use client";

import { useMemo, useState } from "react";
import { CommentItem } from "@/app/Comments";
import type { DashComment, XData } from "@/lib/dashboard";
import { fmtDate, fmtInt, fmtPostTime, fmtSigned, istDay } from "@/lib/metrics";
import { commentDay, commentsCsv, download, isOpen } from "@/lib/orm";
import { inRange, rangePhrase, type DateRange } from "@/lib/range";

type Show = "all" | "customers" | "media" | "open";
const SHOWS: { id: Show; label: string }[] = [
  { id: "all", label: "All" },
  { id: "customers", label: "Customers" },
  { id: "media", label: "Media mentions" },
  { id: "open", label: "Needs response" },
];

// X tab: mentions of @MontraElectric (with Resonia's replies under them), our latest posts
// and the follower count. Comes from the daily X step (lib/xsync.ts).
export function XTab({
  x,
  comments,
  range,
  canHandle,
  publicView,
  onHandled,
  error,
}: {
  x: XData;
  comments: DashComment[]; // X items only: mentions and our replies
  range: DateRange; // the dashboard-wide range
  canHandle: boolean;
  publicView: boolean;
  onHandled: (c: DashComment, handled: boolean) => void;
  error: string | null;
}) {
  const [show, setShow] = useState<Show>("all");
  const phrase = rangePhrase(range);

  const mentions = useMemo(
    () =>
      comments
        .filter((c) => !c.page_reply && inRange(commentDay(c), range))
        .sort((a, b) => Date.parse(b.posted_at ?? "") - Date.parse(a.posted_at ?? "")),
    [comments, range],
  );
  const repliesTo = useMemo(() => {
    const m = new Map<string, DashComment[]>();
    for (const c of comments) if (c.page_reply && c.parent) m.set(c.parent, [...(m.get(c.parent) ?? []), c]);
    for (const list of m.values()) list.sort((a, b) => Date.parse(a.posted_at ?? "") - Date.parse(b.posted_at ?? ""));
    return m;
  }, [comments]);
  const counts: Record<Show, number> = {
    all: mentions.length,
    customers: mentions.filter((c) => !c.media).length,
    media: mentions.filter((c) => c.media).length,
    open: mentions.filter(isOpen).length,
  };
  const list = mentions.filter((c) =>
    show === "customers" ? !c.media : show === "media" ? c.media : show === "open" ? isOpen(c) : true,
  );
  const placeholders = comments.filter((c) => c.x?.placeholder);

  // Followers at the end of the range, and the change since the last count before it (or the
  // first count inside it when tracking started during the range).
  const counted = x.followers.filter((f) => f.date <= range.to);
  const latest = counted.at(-1);
  const before = counted.filter((f) => f.date < range.from).at(-1) ?? counted.find((f) => f.date >= range.from);
  const startCount = before !== latest ? before : undefined;
  const recentPosts = x.posts.filter((p) => inRange(p.posted_at ? istDay(p.posted_at) : null, range));
  const avgLikes = recentPosts.length ? recentPosts.reduce((s, p) => s + p.likes, 0) / recentPosts.length : null;

  if (!x.ready) {
    return (
      <section className="card">
        <h2>X</h2>
        <div className="empty">
          X tracking starts once supabase/schema.sql has been re-run (it adds the x_tweets table).
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="kpis" aria-label="X summary">
        <div className="card">
          <div className="kpi-label">Followers</div>
          <div className="kpi-value">{latest ? fmtInt(latest.followers) : "—"}</div>
          <div className="kpi-foot">
            {latest && startCount
              ? `${fmtSigned(latest.followers - startCount.followers)} since ${fmtDate(`${startCount.date}T12:00:00+05:30`)}`
              : latest
                ? `On ${fmtDate(`${latest.date}T12:00:00+05:30`)}; change shows after two daily counts`
                : "Not counted in this period"}
          </div>
        </div>
        <div className="card">
          <div className="kpi-label">Mentions</div>
          <div className="kpi-value">{counts.all}</div>
          <div className="kpi-foot">
            {counts.customers} from customers, {counts.media} media · {phrase}
          </div>
        </div>
        <div className="card">
          <div className="kpi-label">Needs response</div>
          <div className="kpi-value">{counts.open}</div>
          <div className="kpi-foot">Complaints, leads and questions not yet handled</div>
        </div>
        <div className="card">
          <div className="kpi-label">Our posts</div>
          <div className="kpi-value">{recentPosts.length}</div>
          <div className="kpi-foot">
            {avgLikes == null ? `None, ${phrase}` : `${avgLikes.toFixed(1)} likes per post · ${phrase}`}
          </div>
        </div>
      </section>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div>
            <h2>
              Mentions of{" "}
              <a href={x.profileUrl} target="_blank" rel="noopener noreferrer">
                @{x.handle}
              </a>
            </h2>
            <div className="card-sub">
              Tagging or replying to @{x.handle}, or naming &ldquo;Resonia&rdquo;, with Resonia&apos;s replies
              underneath
              {publicView ? " · usernames and contact details hidden (team sign-in shows them)" : ""}
            </div>
          </div>
          <div className="feed-tools">
            <button
              className="btn"
              disabled={!list.length}
              onClick={() =>
                download(
                  `resonia-pulse-x-mentions_${range.from}_${range.to}.csv`,
                  commentsCsv(
                    list.flatMap((c) => [c, ...(repliesTo.get(c.id) ?? [])]),
                    () => `X @${x.handle}`,
                  ),
                )
              }
            >
              Export CSV
            </button>
          </div>
        </div>
        <div className="chips type-chips" role="group" aria-label="Show">
          {SHOWS.map((s) => (
            <button key={s.id} className="chip" aria-pressed={show === s.id} onClick={() => setShow(s.id)}>
              {s.label}
              <span className="chip-count">{counts[s.id]}</span>
            </button>
          ))}
        </div>
        {placeholders.length > 0 && (
          <div className="banner" role="status">
            {placeholders.length} of Resonia&apos;s X replies went out with a template placeholder still in them (such as
            &ldquo;[customer_support_contact]&rdquo;). They are marked &ldquo;Unfilled template&rdquo; below.
          </div>
        )}
        {error && (
          <div className="banner" role="alert">
            {error}
          </div>
        )}
        {list.length === 0 ? (
          <div className="empty">No mentions match these filters ({phrase}).</div>
        ) : (
          <ul className="cmt-list">
            {list.map((c) => (
              <li key={c.id}>
                <CommentItem c={c} canHandle={canHandle} onHandled={onHandled} />
                {(repliesTo.get(c.id)?.length ?? 0) > 0 && (
                  <ul className="replies">
                    {repliesTo.get(c.id)!.map((r) => (
                      <li key={r.id}>
                        <CommentItem c={r} canHandle={canHandle} onHandled={onHandled} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="note muted">
          Media mention = a news site or brand page; flagged only when negative. &ldquo;Hidden from X search&rdquo; = X
          search does not return the tweet; it was found because Resonia replied to it. Tweets X hides that Resonia has
          not replied to cannot be found.
        </p>
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Our latest posts</h2>
            <div className="card-sub">Engagement is refreshed daily for the latest 5 posts</div>
          </div>
        </div>
        {x.posts.length === 0 ? (
          <div className="empty">No posts saved yet.</div>
        ) : (
          <ul className="post-grid">
            {x.posts.map((p) => (
              <li key={p.id} className="pcard montra">
                <div className="pcard-body">
                  <div className="pcard-head">
                    <span className="post-brand">
                      Resonia <span className="tag x">X</span>
                    </span>
                    {p.posted_at && (
                      <time className="pcard-time" dateTime={p.posted_at}>
                        {fmtPostTime(p.posted_at)}
                      </time>
                    )}
                  </div>
                  <p className="post-text">{p.text}</p>
                  <div className="pcard-stats">
                    <span>
                      <strong>{fmtInt(p.likes)}</strong> likes
                    </span>
                    <span>
                      <strong>{fmtInt(p.replies)}</strong> replies
                    </span>
                    <span>
                      <strong>{fmtInt(p.reposts)}</strong> reposts
                    </span>
                    {p.views != null && (
                      <span>
                        <strong>{fmtInt(p.views)}</strong> views
                      </span>
                    )}
                  </div>
                  <div className="pcard-foot">
                    <a href={p.url} target="_blank" rel="noopener noreferrer">
                      Open on X ↗
                    </a>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
