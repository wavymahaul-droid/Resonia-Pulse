"use client";

import { useRef, useState } from "react";
import type { DashBrand } from "@/lib/dashboard";

type Result =
  | {
      file: string;
      page: string | null;
      kinds: string[];
      rows: number;
      matched: number;
      created: number;
      ads?: number;
      followerGrowth?: { month: string; value: number | null }[];
      unmatched: { title: string; created: string | null; link: string }[];
      otherPage: number;
      dateFrom: string | null;
      dateTo: string | null;
      warnings: string[];
    }
  | { file: string; error: string };

// "Upload LinkedIn analytics": signed-in only. Sends the Content, Followers and Visitors exports
// of a Resonia page to /api/linkedin-upload and shows what was read and matched.
export function LinkedInUpload({ pages, lastUploaded }: { pages: DashBrand[]; lastUploaded: string | null }) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const name = (id: string | null) => pages.find((p) => p.id === id)?.name ?? "no page picked";

  async function upload() {
    const files = input.current?.files;
    if (!files?.length) return setError("Choose one or more export files first.");
    setBusy(true);
    setError(null);
    setResults(null);
    const form = new FormData();
    form.set("page", page);
    for (const f of Array.from(files)) form.append("files", f);
    try {
      const res = await fetch("/api/linkedin-upload", { method: "POST", body: form });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status})`);
      setResults(body.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        Upload LinkedIn analytics
      </button>
      {open && (
        <div className="modal-back" role="presentation" onClick={() => !busy && setOpen(false)}>
          <div
            className="modal card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="li-upload-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="card-head">
              <div>
                <h2 id="li-upload-title">Upload LinkedIn analytics</h2>
                <div className="card-sub">
                  Content, Followers and Visitors exports from a Resonia page&apos;s LinkedIn analytics (.xls, .xlsx or
                  .csv). {lastUploaded ? `Last upload ${new Date(lastUploaded).toLocaleDateString("en-IN")}.` : ""}
                </div>
              </div>
            </div>
            <label className="date-field upload-field">
              Page
              <select className="select" value={page} onChange={(e) => setPage(e.target.value)}>
                <option value="auto">Work it out from the file name</option>
                {pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="date-field upload-field">
              Files
              <input ref={input} type="file" multiple accept=".xls,.xlsx,.csv" />
            </label>
            {error && (
              <div className="banner" role="alert">
                {error}
              </div>
            )}
            {results && (
              <ul className="upload-results">
                {results.map((r, i) =>
                  "error" in r ? (
                    <li key={i} className="down">
                      <b>{r.file}</b>: {r.error}
                    </li>
                  ) : (
                    <li key={i}>
                      <b>{r.file}</b> · {name(r.page)} · {r.kinds.join(", ") || "nothing recognised"}
                      {r.dateFrom && ` · ${r.dateFrom} to ${r.dateTo}`}
                      <br />
                      {r.kinds.includes("content") &&
                        `${r.matched} ${r.matched === 1 ? "post" : "posts"} matched to tracked posts${
                          r.created ? `, ${r.created} added as new posts from the export` : ""
                        }${r.ads ? `, ${r.ads} labelled "Ad (not on feed)" (listed on the Reach card, not in post stats)` : ""}${r.unmatched.length ? `, ${r.unmatched.length} not saved as posts (no page or date)` : ""}. `}
                      {r.otherPage > 0 && `${r.otherPage} matched posts are on another Resonia page. `}
                      {r.followerGrowth?.length
                        ? `Follower growth for ${r.followerGrowth
                            .map((f) => `${f.month}: ${f.value?.toLocaleString("en-IN")}`)
                            .join(", ")} saved to the monthly report. `
                        : ""}
                      {r.warnings.map((w) => (
                        <span key={w} className="down">
                          {w}{" "}
                        </span>
                      ))}
                    </li>
                  ),
                )}
              </ul>
            )}
            <div className="upload-actions">
              <button className="btn" disabled={busy} onClick={() => setOpen(false)}>
                Close
              </button>
              {results ? (
                <button className="btn btn-primary" onClick={() => window.location.reload()}>
                  Done: show the new numbers
                </button>
              ) : (
                <button className="btn btn-primary" disabled={busy} onClick={upload}>
                  {busy ? "Uploading…" : "Upload"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
