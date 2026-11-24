"use client";

// "Video insights" (Insights tab, signed in only): what Gemini heard and saw in recent videos by
// competitors, by Resonia, and in other people's video posts that mention Resonia. Filled every
// evening by the GitHub Actions workflow (.github/workflows/video-insights.yml).
import { useMemo, useState } from "react";
import type { VideoInsight } from "@/lib/dashboard";
import { isRegional, mentionsMontra, videoKind } from "@/lib/videoInsights";

const when = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(new Date(iso))
    : "date unknown";

export const videoPageName = (page: string, pageName: (id: string) => string) =>
  page === "mention:linkedin"
    ? "LinkedIn post mentioning Resonia"
    : page === "mention:x"
      ? "X post mentioning Resonia"
      : page.startsWith("x:")
        ? `X @${page.slice(2)}`
        : pageName(page);

export default function VideoInsights({
  items,
  pageName,
  montraIds,
}: {
  items: VideoInsight[];
  pageName: (id: string) => string;
  montraIds: ReadonlySet<string>;
}) {
  const [onlyMontra, setOnlyMontra] = useState(false);
  const [onlyRegional, setOnlyRegional] = useState(false);
  const [all, setAll] = useState(false); // the newest 10 first; the rest on request
  const tagged = useMemo(
    () =>
      items.map((v) => ({
        v,
        kind: videoKind(v.page, montraIds),
        // Resonia's own videos name Resonia by definition; the filter is about everyone else's.
        montra: videoKind(v.page, montraIds) !== "montra" && mentionsMontra(v),
        regional: isRegional(v.language),
      })),
    [items, montraIds],
  );
  const shown = tagged.filter((t) => (!onlyMontra || t.montra) && (!onlyRegional || t.regional));
  const count = (f: (t: (typeof tagged)[number]) => boolean) => tagged.filter(f).length;

  return (
    <section className="ov-card video-insights" aria-label="Video insights">
      <div className="vi-head">
        <div>
          <h3>Video insights</h3>
          <p className="ov-sub">
            What recent videos say and show: competitors, Resonia, and video posts that mention Resonia. Updated every
            evening.
          </p>
        </div>
        <div className="vi-filters" role="group" aria-label="Filter videos">
          <button type="button" className="chip" aria-pressed={onlyMontra} onClick={() => setOnlyMontra((x) => !x)}>
            Mentions Resonia ({count((t) => t.montra)})
          </button>
          <button type="button" className="chip" aria-pressed={onlyRegional} onClick={() => setOnlyRegional((x) => !x)}>
            Regional language ({count((t) => t.regional)})
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <div className="empty">
          {items.length
            ? "No videos match these filters."
            : "No videos yet: the first results arrive with the evening run."}
        </div>
      ) : (
        <ul className="vi-list">
          {(all ? shown : shown.slice(0, 10)).map(({ v, kind, montra }) => (
            <li key={v.postId} className="vi-item">
              <a href={v.postUrl} target="_blank" rel="noopener noreferrer" className="vi-thumb">
                {v.thumbnail ? (
                  <img src={v.thumbnail} alt="" loading="lazy" />
                ) : (
                  <span className="muted">No thumbnail</span>
                )}
              </a>
              <div className="vi-body">
                <div className="vi-meta">
                  <b>{videoPageName(v.page, pageName)}</b> · {when(v.postedAt)} · {v.language ?? "language unknown"}
                  {v.hasSpeech === false ? " · no speech" : ""} ·{" "}
                  <span className={`vi-tone ${v.tone ?? ""}`}>{v.tone ?? "tone unknown"}</span>
                  {v.confidence ? (
                    <span className="muted" title={v.confidenceReason ?? undefined}>
                      {" "}
                      · {v.confidence} confidence
                    </span>
                  ) : null}
                </div>
                {(montra || kind === "mention") && (
                  <div className="vi-flags">
                    {montra && v.tone === "negative" ? (
                      <span className="vi-flag alert">▲ Negative, mentions Resonia</span>
                    ) : montra && kind === "competitor" ? (
                      <span className="vi-flag alert">▲ Competitor video mentions Resonia</span>
                    ) : (
                      <span className="vi-flag">Mentions Resonia</span>
                    )}
                  </div>
                )}
                <p className="vi-summary">{v.summary || "No summary."}</p>
                {v.brands.length > 0 && <p className="muted small">Brands mentioned: {v.brands.join(", ")}</p>}
                <details className="vi-transcript">
                  <summary>Full transcript</summary>
                  <div className={v.sarvam ? "vi-cols" : undefined}>
                    <div>
                      {v.sarvam && <h5>Gemini</h5>}
                      <h6>Original ({v.language ?? "?"})</h6>
                      <p>{v.transcriptOriginal || (v.hasSpeech === false ? "No speech (music or silent)." : "—")}</p>
                      <h6>English</h6>
                      <p>{v.transcriptEnglish || "—"}</p>
                      {v.onScreenText && (
                        <>
                          <h6>On-screen text</h6>
                          <p>{v.onScreenText}</p>
                        </>
                      )}
                    </div>
                    {v.sarvam && (
                      <div>
                        <h5>Sarvam ({v.sarvam.engine.replace(/^sarvam:/, "")})</h5>
                        <h6>Original ({v.sarvam.language ?? "?"})</h6>
                        <p>{v.sarvam.original || "—"}</p>
                        <h6>English</h6>
                        <p>{v.sarvam.english || "—"}</p>
                      </div>
                    )}
                  </div>
                </details>
              </div>
            </li>
          ))}
        </ul>
      )}
      {shown.length > 10 && (
        <button type="button" className="chip" onClick={() => setAll((x) => !x)}>
          {all ? "Show the newest 10" : `Show all ${shown.length} videos`}
        </button>
      )}
      <p className="muted small">
        Transcribed, translated and summarised automatically (Gemini). Machine transcripts and translations can be
        wrong: check against the video before quoting. Videos longer than 5 minutes are skipped.
      </p>
    </section>
  );
}
