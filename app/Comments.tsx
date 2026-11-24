"use client";

import { useMemo, useState } from "react";
import type { DashBrand, DashComment, DashPost } from "@/lib/dashboard";
import { fmtInt, fmtPostTime } from "@/lib/metrics";
import { rangeQuery, type DateRange } from "@/lib/range";
import { SENTIMENT_ORDER, SEPARATE, commentDay, commentsCsv, download, isOpen, threaded } from "@/lib/orm";

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

// ---------- handled state ----------

type HandledEdit = { handled: boolean; handled_by: string | null };

// Marks applied on this page show at once in the header count, post cards, tab and digest.
export function useHandled(comments: DashComment[]) {
  const [edits, setEdits] = useState<Map<string, HandledEdit>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const list = useMemo(
    () => (edits.size ? comments.map((c) => (edits.has(c.id) ? { ...c, ...edits.get(c.id) } : c)) : comments),
    [comments, edits],
  );
  async function setHandled(c: DashComment, handled: boolean) {
    const put = (v: HandledEdit) => setEdits((m) => new Map(m).set(c.id, v));
    const before = { handled: c.handled, handled_by: c.handled_by };
    put({ handled, handled_by: handled ? "team" : null });
    setError(null);
    try {
      const res = await fetch("/api/comments/handled", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment_id: c.id, handled }),
      });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      put({ handled: body.handled, handled_by: body.handled_by });
    } catch (err) {
      put(before);
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { comments: list, setHandled, error };
}

// ---------- one comment ----------

export function SentimentBadge({ s }: { s: string }) {
  return <span className={`sent sent-${s.toLowerCase()}`}>{s}</span>;
}

export function CommentItem({
  c,
  canHandle,
  onHandled,
  context,
}: {
  c: DashComment;
  canHandle: boolean;
  onHandled: (c: DashComment, handled: boolean) => void;
  context?: { page: string; postUrl: string };
}) {
  // X allows very long posts (news round-ups); they start collapsed.
  const long = c.text.length > 600;
  const [more, setMore] = useState(false);
  return (
    <div className={`cmt${c.page_reply ? " cmt-page" : ""}${isOpen(c) ? " cmt-open" : ""}`}>
      <div className="cmt-head">
        <span className="cmt-name">
          {c.profile ? (
            <a href={c.profile} target="_blank" rel="noopener noreferrer">
              {c.name}
            </a>
          ) : (
            c.name
          )}
          {c.page_reply && <span className="tag teal">Resonia</span>}
          {c.channel === "x" && (
            <span className="tag x" title="X (Twitter)">
              X
            </span>
          )}
          {c.li?.staff && <span className="tag teal">Resonia team</span>}
        </span>
        {c.posted_at && (
          <time className="cmt-time" dateTime={c.posted_at}>
            {fmtPostTime(c.posted_at)}
          </time>
        )}
      </div>
      {c.headline && (
        <div className="cmt-headline">
          {c.headline}
          {c.x?.followers != null && ` · ${fmtInt(c.x.followers)} ${c.x.followers === 1 ? "follower" : "followers"}`}
        </div>
      )}
      <p className={`cmt-text${long && !more ? " clamp" : ""}`}>
        {c.text.replace(/\n{3,}/g, "\n\n") || <em className="muted">(no text)</em>}
      </p>
      {long && (
        <button className="more-link" aria-expanded={more} onClick={() => setMore((m) => !m)}>
          {more ? "Show less" : "Show more"}
        </button>
      )}
      <div className="cmt-foot">
        {!c.page_reply && !c.li?.staff && <SentimentBadge s={c.sentiment} />}
        {c.media && <span className="tag">Media mention</span>}
        {c.x?.placeholder && (
          <span className="flag" title="This reply went out with a template placeholder still in it">
            Unfilled template
          </span>
        )}
        {c.needs_response &&
          (c.handled ? (
            <span className="flag done">
              {c.handled_by === "auto"
                ? "Handled · Resonia replied"
                : c.handled_by === "backfill"
                  ? "Handled · backfilled"
                  : "Handled"}
            </span>
          ) : (
            <span className="flag">Needs response</span>
          ))}
        {c.x ? (
          <XStats likes={c.reactions} replies={c.x.replies} reposts={c.x.reposts} />
        ) : c.li ? (
          <span className="muted">
            {[
              c.reactions ? `${fmtInt(c.reactions)} reactions` : "",
              c.li.comments ? `${fmtInt(c.li.comments)} comments` : "",
              c.li.reposts ? `${fmtInt(c.li.reposts)} reposts` : "",
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : (
          c.reactions > 0 && <span className="muted">{fmtInt(c.reactions)} reactions</span>
        )}
        {c.x?.recovered && (
          <span className="muted" title="X search did not return this tweet; it was found because Resonia replied to it">
            hidden from X search
          </span>
        )}
        {context && !c.channel && (
          <span className="muted">
            {context.page} ·{" "}
            <a href={context.postUrl} target="_blank" rel="noopener noreferrer">
              post ↗
            </a>
          </span>
        )}
        <span className="cmt-actions">
          {c.url && (
            <a href={c.url} target="_blank" rel="noopener noreferrer">
              {c.channel === "x" ? "Open on X ↗" : c.channel === "li_mention" ? "Open post ↗" : "Open ↗"}
            </a>
          )}
          {canHandle && c.needs_response && (
            <button className="btn btn-sm" onClick={() => onHandled(c, !c.handled)}>
              {c.handled ? "Undo handled" : "Mark handled"}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export function XStats({ likes, replies, reposts }: { likes: number; replies: number; reposts: number }) {
  const parts = [
    likes ? `${fmtInt(likes)} ${likes === 1 ? "like" : "likes"}` : "",
    replies ? `${fmtInt(replies)} ${replies === 1 ? "reply" : "replies"}` : "",
    reposts ? `${fmtInt(reposts)} ${reposts === 1 ? "repost" : "reposts"}` : "",
  ].filter(Boolean);
  return parts.length ? <span className="muted">{parts.join(" · ")}</span> : null;
}

export function Thread({
  comments,
  canHandle,
  onHandled,
}: {
  comments: DashComment[];
  canHandle: boolean;
  onHandled: (c: DashComment, handled: boolean) => void;
}) {
  return (
    <ul className="thread">
      {threaded(comments).map(({ comment, replies }) => (
        <li key={comment.id}>
          <CommentItem c={comment} canHandle={canHandle} onHandled={onHandled} />
          {replies.length > 0 && (
            <ul className="replies">
              {replies.map((r) => (
                <li key={r.id}>
                  <CommentItem c={r} canHandle={canHandle} onHandled={onHandled} />
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

// Expandable comment list under a Resonia post card.
export function PostComments({
  comments,
  total,
  canHandle,
  onHandled,
}: {
  comments: DashComment[];
  total: number;
  canHandle: boolean;
  onHandled: (c: DashComment, handled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const openCount = comments.filter(isOpen).length;
  if (!comments.length) {
    return total > 0 ? <div className="pcard-cmts muted">Comments not fetched yet</div> : null;
  }
  return (
    <div className="pcard-cmts">
      <button className="more-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide comments" : `Show ${comments.length} ${comments.length === 1 ? "comment" : "comments"}`}
        {openCount > 0 && <span className="flag">{openCount} need response</span>}
      </button>
      {open && <Thread comments={comments} canHandle={canHandle} onHandled={onHandled} />}
    </div>
  );
}

// ---------- Comments tab ----------

export type CommentFilter = { sentiment: string | "all"; openOnly: boolean };

export function CommentsTab({
  comments,
  brands,
  posts,
  ready,
  canHandle,
  publicView,
  onHandled,
  error,
  range,
  filter,
  setFilter,
}: {
  comments: DashComment[];
  brands: DashBrand[];
  posts: DashPost[];
  ready: boolean;
  canHandle: boolean;
  publicView: boolean;
  onHandled: (c: DashComment, handled: boolean) => void;
  error: string | null;
  range: DateRange; // the dashboard's shared date range
  filter: CommentFilter;
  setFilter: (f: CommentFilter) => void;
}) {
  const [page, setPage] = useState("all");
  const { from, to } = range;
  const [showSpam, setShowSpam] = useState(false);
  const byId = useMemo(() => new Map(brands.map((b) => [b.id, b])), [brands]);
  const postText = useMemo(() => new Map(posts.map((p) => [p.url, p.text])), [posts]);

  const inRange = useMemo(
    () =>
      comments.filter((c) => {
        const d = commentDay(c);
        return (page === "all" || c.brand === page) && !!d && d >= from && d <= to;
      }),
    [comments, page, from, to],
  );
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of inRange) if (!c.page_reply) m.set(c.sentiment, (m.get(c.sentiment) ?? 0) + 1);
    return m;
  }, [inRange]);
  const matching = useMemo(
    () =>
      inRange
        .filter(
          (c) =>
            (filter.sentiment === "all" || (c.sentiment === filter.sentiment && !c.page_reply)) &&
            (!filter.openOnly || isOpen(c)),
        )
        .sort((a, b) => Date.parse(b.posted_at ?? "") - Date.parse(a.posted_at ?? "")),
    [inRange, filter],
  );
  // Under "All", job seekers and spam get their own sections below the customer comments.
  const split = filter.sentiment === "all";
  // LinkedIn mentions (posts by others naming Resonia) get their own section below the comments.
  const liMentions = matching.filter((c) => c.channel === "li_mention");
  const commentsOnly = matching.filter((c) => c.channel !== "li_mention");
  const list = split ? commentsOnly.filter((c) => !SEPARATE.has(c.sentiment)) : commentsOnly;
  const careers = split ? commentsOnly.filter((c) => c.sentiment === "Careers") : [];
  const spam = split ? commentsOnly.filter((c) => c.sentiment === "Spam") : [];
  const exported = [...list, ...liMentions, ...careers, ...(showSpam ? spam : [])];
  const name = (id: string) => byId.get(id)?.name ?? id;
  const renderList = (items: DashComment[]) => (
    <ul className="cmt-list">
      {items.map((c) => (
        <li key={c.id}>
          {c.parent && <div className="cmt-reply-to muted">↳ Reply in a thread</div>}
          <CommentItem
            c={c}
            canHandle={canHandle}
            onHandled={onHandled}
            context={{ page: name(c.brand), postUrl: c.post_url }}
          />
          {postText.get(c.post_url) && <div className="cmt-post muted">On: {clip(postText.get(c.post_url)!, 110)}</div>}
        </li>
      ))}
    </ul>
  );

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2>Comments</h2>
          <div className="card-sub">
            {exported.length} of {inRange.length} comments · {brands.map((b) => b.name).join(", ")}
            {publicView ? " · names and contact details hidden (team sign-in shows them)" : ""}
          </div>
        </div>
        <div className="feed-tools">
          <a className="btn" href={`/digest?${rangeQuery(range)}`}>
            Digest for this period
          </a>
          <button
            className="btn"
            disabled={!exported.length}
            onClick={() => download(`resonia-pulse-comments_${page}_${from}_${to}.csv`, commentsCsv(exported, name))}
          >
            Export CSV
          </button>
        </div>
      </div>

      {!ready ? (
        <div className="empty">
          Comment tracking starts once supabase/schema.sql has been re-run (it adds the comments table).
        </div>
      ) : (
        <>
          <div className="cmt-filters">
            <select
              className="select"
              aria-label="Filter by page"
              value={page}
              onChange={(e) => setPage(e.target.value)}
            >
              <option value="all">All pages</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <label className="check">
              <input
                type="checkbox"
                checked={filter.openOnly}
                onChange={(e) => setFilter({ ...filter, openOnly: e.target.checked })}
              />
              Needs response only
            </label>
          </div>
          <div className="chips type-chips" role="group" aria-label="Sentiment">
            {(["all", ...SENTIMENT_ORDER] as const).map((s) => (
              <button
                key={s}
                className="chip"
                aria-pressed={filter.sentiment === s}
                onClick={() => setFilter({ ...filter, sentiment: s })}
              >
                {s === "all" ? "All" : s}
                <span className="chip-count">
                  {s === "all" ? [...counts.values()].reduce((a, b) => a + b, 0) : (counts.get(s) ?? 0)}
                </span>
              </button>
            ))}
          </div>
          {error && (
            <div className="banner" role="alert">
              {error}
            </div>
          )}
          {list.length === 0 ? (
            <div className="empty">
              {split && (careers.length || spam.length || liMentions.length)
                ? "No customer comments match these filters."
                : "No comments match these filters."}
            </div>
          ) : (
            renderList(list)
          )}
          {liMentions.length > 0 && (
            <div className="cmt-section">
              <h3>
                LinkedIn mentions <span className="chip-count">{liMentions.length}</span>
              </h3>
              <p className="note">
                Public posts by others naming Resonia or EViator. Media mention = a company or media page,
                flagged only when negative; Resonia team = our own staff, never flagged.
              </p>
              {renderList(liMentions)}
            </div>
          )}
          {careers.length > 0 && (
            <div className="cmt-section">
              <h3>
                Job seekers <span className="chip-count">{careers.length}</span>
              </h3>
              <p className="note">Careers comments: not flagged and not counted as leads.</p>
              {renderList(careers)}
            </div>
          )}
          {spam.length > 0 && (
            <div className="cmt-section">
              <h3>
                Spam <span className="chip-count">{spam.length}</span>
                <button className="more-link" onClick={() => setShowSpam((v) => !v)} aria-expanded={showSpam}>
                  {showSpam ? "Hide" : "Show"}
                </button>
              </h3>
              {showSpam && renderList(spam)}
            </div>
          )}
        </>
      )}
    </section>
  );
}
