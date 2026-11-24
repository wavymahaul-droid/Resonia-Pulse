"use client";

import { weekCompetitorVideos } from "@/lib/videoInsights";
import { useMemo, useState } from "react";
import type { DashboardData } from "@/lib/dashboard";
import { formatOf } from "@/lib/insights";
import { fmtInt, fmtPostTime, istDay } from "@/lib/metrics";
import type { RadarData } from "@/lib/radarData";
import { shiftDay } from "@/lib/range";
import { BRIEF_INSTRUCTION, weekly, weeklyBrief } from "@/lib/talking";

export default function TalkingPoints({
  data,
  radar,
  to,
  today,
  signedIn,
}: {
  data: DashboardData;
  radar: RadarData;
  to: string;
  today: string;
  signedIn: boolean;
}) {
  const w = useMemo(
    () => weekly({ posts: data.posts, brands: data.brands, radar: radar.items, to }),
    [data, radar.items, to],
  );
  // Competitor videos of the week with their English summaries (signed-in viewers only).
  const videos = useMemo(() => {
    if (!signedIn || !data.videoInsights) return undefined;
    const names = new Map(data.brands.map((b) => [b.id, b.name]));
    const montra = new Set(data.brands.filter((b) => b.is_montra).map((b) => b.id));
    return weekCompetitorVideos(data.videoInsights, montra, w.week).map((v) => ({
      page: names.get(v.page) ?? v.page,
      postedAt: v.postedAt as string,
      language: v.language,
      summary: v.summary as string,
      url: v.postUrl,
    }));
  }, [data, signedIn, w.week]);
  const [copied, setCopied] = useState<string | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(weeklyBrief(w, { notes: signedIn, videos }));
      setCopied("Copied");
    } catch {
      setCopied("Copy failed");
    }
    setTimeout(() => setCopied(null), 2500);
  }
  const prev = shiftDay(to, -7);
  const next = shiftDay(to, 7);

  return (
    <div className="wrap talking">
      <header className="header">
        <div>
          <div className="eyebrow">
            <a href="/">← Dashboard</a> · <a href="/radar">Industry Radar</a> · <a href="/top">Top posts</a>
          </div>
          <h1>
            Talking <span className="accent">points</span>
          </h1>
          <div className="card-sub">
            {w.label} · <a href={`/talking-points?to=${prev}`}>← Previous week</a>
            {to < today && (
              <>
                {" · "}
                <a href={next >= today ? "/talking-points" : `/talking-points?to=${next}`}>Next week →</a>
              </>
            )}
          </div>
        </div>
        <div className="sync digest-tools">
          <button className="btn btn-primary" onClick={copy} title={BRIEF_INSTRUCTION}>
            {copied ?? "Copy weekly brief"}
          </button>
        </div>
      </header>

      <section className="ov-section">
        <div className="ov-head">
          <h2>Competitors&apos; best posts this week</h2>
          <a className="ov-more" href="/top">
            See more →
          </a>
        </div>
        {w.top.length ? (
          <div className="tp-list">
            {w.top.map((c, i) => (
              <a
                key={c.post.url}
                className="ov-card tp-post"
                href={c.post.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="tp-rank">{i + 1}</span>
                <div className="tp-thumb">{c.post.image ? <img src={c.post.image} alt="" loading="lazy" /> : null}</div>
                <div className="tp-body">
                  <div className="ov-post-head">
                    <b>{c.brand.name}</b>
                    <span className="muted">{fmtPostTime(c.post.posted_at)}</span>
                  </div>
                  <div className="radar-tags">
                    <span className="tag">{c.post.theme}</span>
                    <span className="tag">{formatOf(c.post.media)}</span>
                  </div>
                  <p className="ov-post-text">{c.post.text || "(no text)"}</p>
                  <div className="ov-post-metric">
                    <b>{fmtInt(c.value)}</b> likes + comments
                    <span className="ov-multiple">{c.multiple.toFixed(1)}× page average</span>
                    <span className="muted small">(usually {fmtInt(Math.round(c.pageAvg))})</span>
                  </div>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <div className="ov-card empty">No competitor posts this week.</div>
        )}
      </section>

      <section className="ov-section">
        <div className="ov-head">
          <h2>Themes competitors covered that Resonia didn&apos;t</h2>
          <a className="ov-more" href="/insights">
            See more →
          </a>
        </div>
        {w.gaps.length ? (
          <ul className="ov-signals">
            {w.gaps.map((g) => (
              <li key={g.theme}>
                <span className="ov-dot" aria-hidden />
                <span>
                  <b>{g.theme}</b>: {g.posts} competitor {g.posts === 1 ? "post" : "posts"} ({g.pages.join(", ")}).
                  Best:{" "}
                  <a href={g.example.post.url} target="_blank" rel="noopener noreferrer">
                    {g.example.brand.name}, {g.example.multiple.toFixed(1)}× page average
                  </a>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ov-card empty">Resonia covered every theme the competitors posted about this week.</div>
        )}
      </section>

      <section className="ov-section">
        <div className="ov-head">
          <h2>High-relevance Radar this week</h2>
          <a className="ov-more" href="/radar">
            See more →
          </a>
        </div>
        {!radar.ready ? (
          <div className="ov-card empty">The Industry Radar starts with the next 7am fetch.</div>
        ) : w.radar.length ? (
          <ul className="ov-signals">
            {w.radar.map((r) => (
              <li key={r.url}>
                <span className="ov-dot" aria-hidden />
                <span>
                  <a href={r.url} target="_blank" rel="noopener noreferrer">
                    {r.title}
                  </a>{" "}
                  <span className="muted small">
                    {r.source} · {r.published_at ? istDay(r.published_at) : "undated"} · {r.type} · {r.pages.join(", ")}
                  </span>
                  {r.note && (
                    <div className="small">
                      <b>Why it matters:</b> {r.note}
                    </div>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ov-card empty">No High-relevance headlines this week.</div>
        )}
      </section>

      <p className="note muted">
        &ldquo;Copy weekly brief&rdquo; copies all of the above as one plain-text block, starting with: &ldquo;
        {BRIEF_INSTRUCTION}
        &rdquo; Paste it into your AI assistant. Built from stored data only.
      </p>
    </div>
  );
}
