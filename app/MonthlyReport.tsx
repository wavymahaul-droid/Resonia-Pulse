"use client";

import { useMemo, useState } from "react";
import type { DashboardData } from "@/lib/dashboard";
import { fmtInt } from "@/lib/metrics";
import {
  blockCsv,
  blockText,
  buildMonthly,
  DECK_PAGES,
  fmtCell,
  monthLabel,
  shiftMonth,
  type Block,
  type ExportPostRow,
  type HistoryRow,
  type PostItem,
  type Row,
  type Table,
} from "@/lib/monthly";
import { download } from "@/lib/orm";

export type MonthlyData = { exportPosts: ExportPostRow[]; history: HistoryRow[]; historyReady: boolean };

// The deck's monthly blocks for one calendar month, each with Copy as text and CSV.
export default function MonthlyReport({
  data,
  monthly,
  month,
  today,
  signedIn,
  onMonth,
}: {
  data: DashboardData;
  monthly: MonthlyData;
  month: string;
  today: string;
  signedIn: boolean;
  onMonth: (month: string) => void;
}) {
  const [history, setHistory] = useState(monthly.history);
  const m = useMemo(
    () =>
      buildMonthly({
        month,
        days: data.liExport.pages,
        exportPosts: monthly.exportPosts,
        history,
        posts: data.posts,
        brands: data.brands,
        followers: data.followers,
      }),
    [month, data, monthly.exportPosts, history],
  );
  const options = Array.from({ length: 12 }, (_, i) => shiftMonth(today.slice(0, 7), -i));
  const canEdit = signedIn && monthly.historyReady;
  const thumbs = [...(m.topPosts.posts ?? []), ...(m.competitors.posts ?? [])];

  return (
    <section className="monthly" aria-label="Monthly client report">
      <div className="monthly-head">
        <div>
          <h2>Monthly client report</h2>
          <div className="card-sub">
            The deck&apos;s blocks for one month. LinkedIn figures are LinkedIn&apos;s own (All: organic + sponsored)
            from the uploaded exports.
          </div>
        </div>
        <div className="sync digest-tools">
          <label className="month-pick">
            <span className="sr-only">Month</span>
            <select value={month} onChange={(e) => onMonth(e.target.value)}>
              {options.map((o) => (
                <option key={o} value={o}>
                  {monthLabel(o)}
                </option>
              ))}
            </select>
          </label>
          <ThumbsButton posts={thumbs} name={`montra-thumbnails_${month}.zip`} />
        </div>
      </div>

      <BlockCard block={m.overall} month={month} />
      <BlockCard
        block={m.mom}
        month={month}
        edit={
          canEdit
            ? {
                months: m.months,
                history,
                onSaved: (rows) =>
                  setHistory((h) => [
                    ...h.filter((x) => !rows.some((r) => r.brand === x.brand && r.month === x.month)),
                    ...rows.filter(
                      (r) =>
                        r.followerGrowth != null || r.engagement != null || r.impressions != null || r.posts != null,
                    ),
                  ]),
              }
            : undefined
        }
        footnote={
          monthly.historyReady
            ? signedIn
              ? "Edit a page's months to enter or correct deck figures; clearing all four removes the month so the exports are used."
              : null
            : "The entered history is built in for now; re-run supabase/schema.sql to store and edit it."
        }
      />
      <BlockCard block={m.competitors} month={month} />
      <BlockCard block={m.worked} month={month} />
      <BlockCard block={m.topPosts} month={month} />
    </section>
  );
}

type Edit = { months: string[]; history: HistoryRow[]; onSaved: (rows: HistoryRow[]) => void };

function BlockCard({
  block: b,
  month,
  edit,
  footnote,
}: {
  block: Block;
  month: string;
  edit?: Edit;
  footnote?: string | null;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(blockText(b));
      setCopied("Copied");
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(null), 2500);
  }
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div>
          <h2>{b.title}</h2>
          <div className="card-sub">{b.sub}</div>
        </div>
        <div className="sync digest-tools">
          <button className="btn btn-sm" onClick={copy}>
            {copied ?? "Copy as text"}
          </button>
          <button className="btn btn-sm" onClick={() => download(`montra-${b.id}_${month}.csv`, blockCsv(b))}>
            CSV
          </button>
        </div>
      </div>
      {b.posts && b.posts.length > 0 && <PostList posts={b.posts} />}
      {b.tables
        .filter((t) => !(b.posts?.length && t.head[0] === "#"))
        .map((t, i) => (
          <TableView
            key={i}
            table={t}
            edit={edit && b.id === "mom" ? { ...edit, brand: DECK_PAGES[i]?.id } : undefined}
          />
        ))}
      {b.posts && b.posts.length === 0 && <div className="empty">No posts for this month.</div>}
      {[...(b.notes ?? []), ...(footnote ? [footnote] : [])].map((n) => (
        <p key={n} className="note muted">
          {n}
        </p>
      ))}
    </section>
  );
}

function TableView({ table: t, edit }: { table: Table; edit?: Edit & { brand?: string } }) {
  const [editing, setEditing] = useState(false);
  return (
    <>
      {(t.title || edit) && (
        <h3 className="digest-h3">
          {t.title}{" "}
          {edit?.brand && !editing && (
            <button className="more-link" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
        </h3>
      )}
      {editing && edit?.brand ? (
        <HistoryEditor brand={edit.brand} edit={edit} onDone={() => setEditing(false)} />
      ) : (
        <div className="table-scroll">
          <table className="perf monthly-table">
            <thead>
              <tr>
                {t.head.map((h, i) => (
                  <th key={i} className={i === 0 ? "left" : undefined}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.length === 0 && (
                <tr>
                  <td colSpan={t.head.length} className="muted">
                    None this month
                  </td>
                </tr>
              )}
              {t.rows.map((r) => (
                <tr key={r.label}>
                  <td className="left">{r.label}</td>
                  {r.cells.map((c, i) => (
                    <CellView key={i} row={r} i={i} value={c} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(t.notes ?? []).map((n) => (
        <p key={n} className="note muted small">
          {n}
        </p>
      ))}
    </>
  );
}

function CellView({ row, i, value }: { row: Row; i: number; value: Row["cells"][number] }) {
  const fmt = Array.isArray(row.fmt) ? row.fmt[i] : row.fmt;
  const src = row.src?.[i];
  if (typeof value === "string" && /^https?:\/\//.test(value))
    return (
      <td>
        <a href={value} target="_blank" rel="noopener noreferrer">
          View ↗
        </a>
      </td>
    );
  return (
    <td className={fmt === "text" ? "left" : undefined}>
      {fmtCell(value, fmt) || <span className="muted">—</span>}
      {src === "history" && (
        <span className="src-mark" title="Entered in the report history (from an earlier deck)">
          {" "}
          ·e
        </span>
      )}
    </td>
  );
}

const FIELDS = [
  ["followerGrowth", "Follower growth"],
  ["engagement", "Engagement"],
  ["impressions", "Impressions"],
  ["posts", "No. of posts"],
] as const;

function HistoryEditor({ brand, edit, onDone }: { brand: string; edit: Edit; onDone: () => void }) {
  const start = (m: string) => edit.history.find((h) => h.brand === brand && h.month === m);
  const [vals, setVals] = useState(
    () =>
      Object.fromEntries(
        edit.months.map((m) => [m, Object.fromEntries(FIELDS.map(([k]) => [k, start(m)?.[k]?.toString() ?? ""]))]),
      ) as Record<string, Record<string, string>>,
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError(null);
    const saved: HistoryRow[] = [];
    try {
      for (const m of edit.months) {
        const n = (k: string) => (vals[m][k].trim() === "" ? null : Number(vals[m][k].replace(/[,\s]/g, "")));
        const row = {
          brand,
          month: m,
          followerGrowth: n("followerGrowth"),
          engagement: n("engagement"),
          impressions: n("impressions"),
          posts: n("posts"),
        };
        const before = start(m);
        if (FIELDS.every(([k]) => (before?.[k] ?? null) === row[k])) continue;
        if (FIELDS.some(([k]) => row[k] != null && !Number.isInteger(row[k])))
          throw new Error(`whole numbers only (${monthLabel(m, true)})`);
        const res = await fetch("/api/report-history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand_id: brand,
            month: m,
            follower_growth: row.followerGrowth,
            engagement: row.engagement,
            impressions: row.impressions,
            posts: row.posts,
          }),
        });
        const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
        saved.push(row);
      }
      edit.onSaved(saved);
      onDone();
    } catch (err) {
      if (saved.length) edit.onSaved(saved);
      setError(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="history-edit">
      <div className="table-scroll">
        <table className="perf monthly-table">
          <thead>
            <tr>
              <th className="left" />
              {edit.months.map((m) => (
                <th key={m}>{monthLabel(m, true)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {FIELDS.map(([k, label]) => (
              <tr key={k}>
                <td className="left">{label}</td>
                {edit.months.map((m) => (
                  <td key={m}>
                    <input
                      className="num-input"
                      inputMode="numeric"
                      aria-label={`${label}, ${monthLabel(m)}`}
                      placeholder="from export"
                      value={vals[m][k]}
                      onChange={(e) => setVals((v) => ({ ...v, [m]: { ...v[m], [k]: e.target.value } }))}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="down">{error}</p>}
      <div className="history-actions">
        <button className="btn btn-sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="btn btn-sm" onClick={onDone} disabled={saving}>
          Cancel
        </button>
        <span className="muted small">Leave a month blank to use the uploaded exports.</span>
      </div>
    </div>
  );
}

function PostList({ posts }: { posts: PostItem[] }) {
  return (
    <ol className="monthly-posts">
      {posts.map((p) => (
        <li key={p.url}>
          {p.image ? (
            <a href={p.url} target="_blank" rel="noopener noreferrer" className="monthly-thumb" tabIndex={-1}>
              <img src={p.image} alt="" loading="lazy" />
            </a>
          ) : (
            <span className="monthly-thumb pcard-noimg">No image saved</span>
          )}
          <div>
            <b>{p.page}</b> <span className="muted">· {p.date}</span>
            <div className="top-text post-text">{p.text || "(no text)"}</div>
            <div className="muted small">{p.stats}</div>
            <a href={p.url} target="_blank" rel="noopener noreferrer">
              View post ↗
            </a>
          </div>
        </li>
      ))}
    </ol>
  );
}

// Saves the thumbnails of the listed posts as one .zip (built on the server from the stored images).
function ThumbsButton({ posts, name }: { posts: PostItem[]; name: string }) {
  const [state, setState] = useState<string | null>(null);
  const withImage = posts.filter((p) => p.image);
  async function run() {
    setState("Preparing…");
    try {
      const res = await fetch("/api/thumbnails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: withImage.map((p) => ({ post_url: p.url, name: p.file })) }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
      const missing = Number(res.headers.get("X-Missing") ?? 0);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await res.blob());
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      setState(missing ? `${fmtInt(missing)} had no saved thumbnail` : null);
    } catch (err) {
      setState(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    setTimeout(() => setState(null), 4000);
  }
  return (
    <button
      className="btn"
      onClick={run}
      disabled={!withImage.length || state === "Preparing…"}
      title="Top Resonia posts and standout competitor posts, as a .zip"
    >
      {state ?? `Download thumbnails (${withImage.length})`}
    </button>
  );
}
