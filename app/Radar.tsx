"use client";

import { useMemo, useState } from "react";
import { fmtDateTime, istDay } from "@/lib/metrics";
import { shiftDay } from "@/lib/range";
import {
  RADAR,
  RADAR_PAGES,
  RADAR_TYPES,
  type RadarItem,
  type RadarPage,
  type RadarType,
  type Relevance,
} from "@/lib/radar";
import type { RadarData } from "@/lib/radarData";

const shortDay = (iso: string) =>
  new Date(`${istDay(iso)}T12:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

export default function Radar({
  data,
  signedIn,
  canEdit,
  today,
}: {
  data: RadarData;
  signedIn: boolean;
  canEdit: boolean;
  today: string;
}) {
  const [type, setType] = useState<RadarType | "all">("all");
  const [page, setPage] = useState<RadarPage | "all">("all");
  const [rel, setRel] = useState<Relevance | "all">("all");
  // Default: High only, last 7 days; "All" shows every headline of the last 60 days.
  const [focus, setFocus] = useState(true);
  const weekFrom = shiftDay(today, -6);
  const [notes, setNotes] = useState<Map<string, string | null>>(new Map());
  const [fetching, setFetching] = useState<string | null>(null);
  const items = useMemo(
    () =>
      data.items
        .map((i) => (notes.has(i.url) ? { ...i, note: notes.get(i.url) } : i))
        .filter(
          (i) =>
            (type === "all" || i.type === type) &&
            (page === "all" || i.pages.includes(page)) &&
            (focus
              ? i.relevance === "High" && !!i.published_at && istDay(i.published_at) >= weekFrom
              : rel === "all" || i.relevance === rel),
        ),
    [data.items, notes, type, page, rel, focus, weekFrom],
  );
  const failed = data.feeds.filter((f) => !f.ok);
  const timedOut = failed.filter((f) => /^(Timed out|Skipped)/.test(f.error ?? "")).length;

  async function fetchNow() {
    setFetching("Fetching…");
    try {
      const res = await fetch("/api/radar/refresh", { method: "POST" });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setFetching(`${body.saved} new from ${body.feedsOk} of ${body.feeds} feeds. Reloading…`);
      window.location.reload();
    } catch (err) {
      setFetching(`Fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div className="wrap radar">
      <header className="header">
        <div>
          <div className="eyebrow">
            <a href="/">← Dashboard</a> · <a href="/talking-points">Talking points</a> · <a href="/top">Top posts</a>
          </div>
          <h1>
            Industry <span className="accent">Radar</span>
          </h1>
          <div className="card-sub">
            Policy, market, competitor, charging and customer-sector headlines from free news feeds, last{" "}
            {RADAR.keepDays} days.
            {data.lastChecked && ` Last checked ${fmtDateTime(data.lastChecked)}.`}
          </div>
        </div>
        {signedIn && (
          <div className="sync digest-tools">
            <button className="btn" onClick={fetchNow} disabled={fetching === "Fetching…"}>
              {fetching ?? "Fetch now"}
            </button>
          </div>
        )}
      </header>

      {!data.ready ? (
        <div className="card empty">
          Re-run supabase/schema.sql to add the Radar tables; headlines arrive with the next 7am fetch.
        </div>
      ) : (
        <>
          <div className="filters radar-filters">
            <div className="seg radar-view" role="group" aria-label="View">
              <button aria-pressed={focus} onClick={() => setFocus(true)}>
                High, last 7 days
              </button>
              <button aria-pressed={!focus} onClick={() => setFocus(false)}>
                All
              </button>
            </div>
            <Seg
              label="Type"
              value={type}
              options={["all", ...RADAR_TYPES]}
              onChange={(v) => setType(v as RadarType | "all")}
            />
            <Seg
              label="Page"
              value={page}
              options={["all", ...RADAR_PAGES]}
              onChange={(v) => setPage(v as RadarPage | "all")}
            />
            {!focus && (
              <Seg
                label="Relevance"
                value={rel}
                options={["all", "High", "Medium"]}
                onChange={(v) => setRel(v as Relevance | "all")}
              />
            )}
          </div>
          <p className="muted small">
            {items.length} of {data.items.length} headlines
            {focus ? " (High relevance, last 7 days)" : " (last 60 days)"} · tags are keyword rules (radar.json), so
            check before you rely on one.
          </p>
          {items.length === 0 ? (
            <div className="card empty">No headlines match these filters{data.items.length ? "" : " yet"}.</div>
          ) : (
            <div className="radar-grid">
              {items.map((i) => (
                <RadarCard
                  key={i.url}
                  item={i}
                  today={today}
                  canEdit={canEdit}
                  onSaved={(note) => setNotes((m) => new Map(m).set(i.url, note))}
                />
              ))}
            </div>
          )}
          {signedIn && data.feeds.length > 0 && (
            <details className="ov-details radar-feeds">
              <summary>
                <span>Feeds</span>
                <span className="muted">
                  {data.feeds.length - failed.length} of {data.feeds.length} working on the last fetch
                  {timedOut ? ` · ${timedOut} timed out or skipped at the time cap` : ""}
                  {failed.length - timedOut ? ` · ${failed.length - timedOut} failed` : ""}
                </span>
              </summary>
              <div className="table-scroll">
                <table className="perf">
                  <thead>
                    <tr>
                      <th className="left">Feed</th>
                      <th>Status</th>
                      <th>Items</th>
                      <th className="left">Checked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.feeds.map((f) => (
                      <tr key={f.name}>
                        <td className="left">
                          <a href={f.url} target="_blank" rel="noopener noreferrer">
                            {f.name}
                          </a>
                        </td>
                        <td className={f.ok ? undefined : "radar-skip"} title={f.error ?? undefined}>
                          {f.ok ? "OK" : (f.error ?? "Failed")}
                        </td>
                        <td>{f.items}</td>
                        <td className="left muted">{fmtDateTime(f.checked_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function Seg({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="chips" role="group" aria-label={label}>
      <span className="muted small radar-seg-label">{label}</span>
      {options.map((o) => (
        <button key={o} className="chip" aria-pressed={value === o} onClick={() => onChange(o)}>
          {o === "all" ? "All" : o}
        </button>
      ))}
    </div>
  );
}

function RadarCard({
  item: i,
  today,
  canEdit,
  onSaved,
}: {
  item: RadarItem;
  today: string;
  canEdit: boolean;
  onSaved: (note: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(i.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const fresh = i.published_at && istDay(i.published_at) >= today;
  async function save() {
    setError(null);
    try {
      const res = await fetch("/api/radar/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: i.url, note: draft }),
      });
      const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      onSaved(body.note);
      setEditing(false);
    } catch (err) {
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return (
    <article className={`ov-card radar-card${i.relevance === "High" ? " high" : ""}`}>
      <div className="radar-tags">
        <span className={`tag${i.relevance === "High" ? " teal" : ""}`}>{i.relevance}</span>
        <span className="tag">{i.type}</span>
        {i.pages.map((p) => (
          <span key={p} className="tag radar-page">
            {p}
          </span>
        ))}
        {fresh && <span className="tag radar-new">Today</span>}
        {i.why && (
          <span className="muted small radar-why" title="Why this is High">
            {i.why}
          </span>
        )}
      </div>
      <h3>
        <a href={i.url} target="_blank" rel="noopener noreferrer">
          {i.title}
        </a>
      </h3>
      {i.snippet && <p className="radar-snippet">{i.snippet}</p>}
      <div className="radar-meta muted small">
        {i.source ?? "Unknown source"} · {i.published_at ? shortDay(i.published_at) : "undated"}
        {i.query && !i.query.startsWith(i.source ?? "\u0000") && ` · found by “${i.query}”`}
      </div>
      {canEdit &&
        (editing ? (
          <div className="radar-note-edit">
            <textarea
              value={draft}
              maxLength={1000}
              rows={3}
              placeholder="Why it matters for Resonia"
              onChange={(e) => setDraft(e.target.value)}
            />
            {error && <p className="down small">{error}</p>}
            <div className="history-actions">
              <button className="btn btn-sm" onClick={save}>
                Save
              </button>
              <button className="btn btn-sm" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : i.note ? (
          <div className="radar-note">
            <b>Why it matters:</b> {i.note}{" "}
            <button className="more-link" onClick={() => setEditing(true)}>
              Edit
            </button>
          </div>
        ) : (
          <button className="more-link" onClick={() => setEditing(true)}>
            + Why it matters
          </button>
        ))}
    </article>
  );
}
