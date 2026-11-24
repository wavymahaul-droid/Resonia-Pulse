"use client";

import { useMemo, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import FollowersSection from "@/app/FollowersSection";
import type { DashBrand, DashComment, DashPost, FollowerPoint, LiExportData, VideoInsight } from "@/lib/dashboard";
import { fmtCompact, fmtInt, fmtPct, fmtPostTime } from "@/lib/metrics";
import {
  dailyEngagement,
  overviewTiles,
  pageAverages,
  sovSlices,
  standouts,
  STANDOUT_MULTIPLE,
  themeShares,
  todaysSignals,
  type Tile,
} from "@/lib/overview";
import type { RadarItem } from "@/lib/radar";
import { LI_EXPORTS_ENABLED } from "@/lib/brands";
import { rangeQuery, type DateRange } from "@/lib/range";
import { weekly } from "@/lib/talking";
import { videoAlerts } from "@/lib/videoInsights";

// Chart colors come from CSS variables (light and dark values in globals.css): Resonia teal,
// competitors grey; amber only for alerts.
const C = {
  montra: "var(--c-montra)",
  compFill: "var(--c-comp-fill)",
  compLine: "var(--c-comp-line)",
  others: "var(--c-others)",
  grid: "var(--c-grid)",
  axis: "var(--c-axis)",
  surface: "var(--surface)",
};
const AXIS = { fontSize: 11, fill: C.axis };
// Round axis steps (1, 2, 2.5 or 5 × a power of ten), about 4 of them.
function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const top = Math.ceil(max / step - 1e-9) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}
const shortDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

export default function Overview({
  posts,
  allBrands,
  brands,
  li,
  comments,
  range,
  today,
  trackingSince,
  publicView = false,
  followers = [],
  radar = [],
  videos = [],
}: {
  posts: DashPost[]; // feed posts (ads excluded)
  allBrands: DashBrand[];
  brands: DashBrand[]; // the segment's pages
  li: LiExportData;
  comments: DashComment[];
  range: DateRange;
  today: string;
  trackingSince: string | null;
  publicView?: boolean;
  followers?: FollowerPoint[];
  radar?: RadarItem[];
  videos?: VideoInsight[]; // signed-in viewers only
}) {
  const q = rangeQuery(range);
  const tiles = useMemo(
    () =>
      overviewTiles({ li, posts, brands, range, today, followers }).filter(
        (t) => LI_EXPORTS_ENABLED || (t.key !== "impressions" && t.key !== "engagements"),
      ),
    [li, posts, brands, range, today, followers],
  );
  const slices = useMemo(() => sovSlices(posts, brands, range), [posts, brands, range]);
  const avgs = useMemo(() => pageAverages(posts, brands, range), [posts, brands, range]);
  const themes = useMemo(() => themeShares(posts, brands, range), [posts, brands, range]);
  const daily = useMemo(() => dailyEngagement(posts, brands, range.to), [posts, brands, range.to]);
  const stand = useMemo(() => standouts(posts, brands, range), [posts, brands, range]);
  const talk = useMemo(() => weekly({ posts, brands: allBrands, radar, to: today }), [posts, allBrands, radar, today]);
  const signals = useMemo(
    () =>
      todaysSignals({
        posts,
        brands: allBrands,
        comments,
        range,
        today,
        trackingSince,
        showQuiet: !publicView,
        // Videos that mention Resonia (a competitor's, or with a negative tone), last 7 days.
        video: videoAlerts(videos, {
          montraIds: new Set(allBrands.filter((b) => b.is_montra).map((b) => b.id)),
          pageName: (id) => allBrands.find((b) => b.id === id)?.name ?? id,
          today,
        }).map((a) => ({ text: a.text, alert: true, href: a.href })),
      }),
    [posts, allBrands, comments, range, today, trackingSince, publicView, videos],
  );

  return (
    <div className="ov">
      <section className="ov-tiles" aria-label="Key numbers">
        {tiles.map((t) => (
          <KpiTile key={t.key} t={t} />
        ))}
      </section>

      <FollowersSection days={li.pages} followers={followers} today={today} />

      <OvSection title="Where we stand" more={`/insights?${q}`}>
        <div className="ov-grid">
          <div className="ov-card">
            <h3>Share of voice</h3>
            <p className="ov-sub">Public interactions on posts in this period</p>
            <SovDonut slices={slices} />
          </div>
          <div className="ov-card">
            <h3>Average likes + comments per post</h3>
            <p className="ov-sub">Every page, highest first</p>
            <PageBars rows={avgs} />
          </div>
        </div>
      </OvSection>

      <OvSection title="What everyone's talking about" more={`/insights?${q}`}>
        <div className="ov-grid">
          <div className="ov-card">
            <h3>Theme share</h3>
            <p className="ov-sub">% of posts per theme, Resonia vs competitors</p>
            <ThemeBars rows={themes} />
          </div>
          <div className="ov-card">
            <h3>Daily likes + comments, per page</h3>
            <p className="ov-sub">On posts published each day, last 30 days to {shortDay(range.to)}</p>
            <DailyLine rows={daily} />
          </div>
        </div>
      </OvSection>

      <OvSection
        title={stand.some((s) => s.multiple >= STANDOUT_MULTIPLE) ? "This week's standouts" : "This week's best posts"}
        more={`/top?${q}`}
      >
        {stand.length ? (
          <div className="ov-stand">
            {stand.map((s) => (
              <a
                key={s.post.url}
                className={`ov-card ov-post${s.brand.is_montra ? " montra" : ""}`}
                href={s.post.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <div className="ov-thumb">
                  {s.post.image ? <img src={s.post.image} alt="" loading="lazy" /> : <span>No image saved</span>}
                </div>
                <div className="ov-post-body">
                  <div className="ov-kicker">
                    {s.multiple >= STANDOUT_MULTIPLE
                      ? "Standout"
                      : s.brand.is_montra
                        ? "Best Resonia post this week"
                        : "Best competitor post this week"}
                  </div>
                  <div className="ov-post-head">
                    <b>{s.brand.name}</b>
                    <span className="muted">{fmtPostTime(s.post.posted_at)}</span>
                  </div>
                  <p className="ov-post-text">{s.post.text || "(no text)"}</p>
                  <div className="ov-post-metric">
                    <b>{fmtInt(s.value)}</b> likes + comments
                    <span className="ov-multiple">{s.multiple.toFixed(1)}× page average</span>
                  </div>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <div className="ov-card empty">No posts in the last 7 days of this period.</div>
        )}
      </OvSection>

      <section className="ov-section">
        <div className="ov-head">
          <h2>Content gaps</h2>
        </div>
        <div className="ov-grid">
          <div className="ov-card">
            <div className="ov-card-head">
              <h3>This week vs competitors</h3>
            </div>
            <p className="ov-sub">This week, for the next post ideas</p>
            <ul className="ov-radar">
              {talk.top[0] && (
                <li>
                  <span>
                    Best competitor post: <b>{talk.top[0].brand.name}</b>, {talk.top[0].multiple.toFixed(1)}× its page
                    average ({talk.top[0].post.theme})
                  </span>
                </li>
              )}
              <li>
                <span>
                  {talk.gaps.length
                    ? `Themes competitors covered that Resonia didn't: ${talk.gaps
                        .slice(0, 3)
                        .map((g) => g.theme)
                        .join(", ")}${talk.gaps.length > 3 ? ` and ${talk.gaps.length - 3} more` : ""}`
                    : "Resonia covered every theme the competitors posted about"}
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>

      <OvSection title="Today's signals">
        <ul className="ov-signals">
          {signals.map((s) => (
            <li key={s.text} className={s.alert ? "alert" : undefined}>
              <span className="ov-dot" aria-hidden />
              {s.alert && <span className="sr-only">Alert: </span>}
              {s.href ? (
                <a href={s.href} target={s.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">
                  {s.text}
                </a>
              ) : (
                s.text
              )}
            </li>
          ))}
          {!signals.length && <li>Nothing stands out today.</li>}
        </ul>
      </OvSection>
    </div>
  );
}

function OvSection({ title, more, children }: { title: string; more?: string; children: ReactNode }) {
  return (
    <section className="ov-section">
      <div className="ov-head">
        <h2>{title}</h2>
        {more && (
          <a className="ov-more" href={more}>
            See more →
          </a>
        )}
      </div>
      {children}
    </section>
  );
}

// ---------- KPI tile ----------

function KpiTile({ t }: { t: Tile }) {
  const value = t.value == null ? "—" : t.pct ? fmtPct(t.value, 1) : fmtCompact(t.value);
  const change =
    t.noPrev || t.change == null
      ? "No comparable earlier data"
      : t.pct
        ? `${t.change >= 0 ? "▲" : "▼"} ${Math.abs(t.change * 100).toFixed(1)} pts vs previous period`
        : `${t.change >= 0 ? "▲" : "▼"} ${Math.abs(t.change * 100).toFixed(0)}% vs previous period`;
  const has = t.spark.some((p) => p.v != null);
  return (
    <div className={`ov-card ov-tile${t.stale ? " stale" : ""}`}>
      <div className="ov-tile-label" title={t.tip}>
        {t.label}
        {t.tip && (
          <span className="ov-info" aria-label={t.tip}>
            {" "}
            ⓘ
          </span>
        )}
      </div>
      <div className={`ov-tile-value${t.valueText ? " ov-tile-value-text" : ""}`}>{t.valueText ?? value}</div>
      {t.extra && (
        <div className="ov-tile-extra" title={t.extra.tip}>
          <div>{t.extra.line}</div>
          {t.extra.pages && <div className="ov-tile-pages">{t.extra.pages}</div>}
        </div>
      )}
      <div className="ov-tile-change">{change}</div>
      <div className="ov-spark" aria-hidden>
        {has && (
          <ResponsiveContainer width="100%" height={40}>
            <LineChart data={t.spark} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
              <Line
                type="monotone"
                dataKey="v"
                stroke={t.key === "sov" || !t.stale ? C.montra : C.compLine}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="ov-tile-foot">
        {t.foot}
        {t.lastExport !== undefined && (
          <span className={t.stale ? "ov-stale" : undefined}>
            {" · "}Last export: {t.lastExport ? shortDay(t.lastExport) : "none"}
            {t.stale ? " (over 10 days old)" : ""}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------- charts ----------

function ChartTip({
  active,
  payload,
  label,
  format,
}: {
  active?: boolean;
  payload?: { name?: string; value?: number; color?: string; payload?: Record<string, unknown> }[];
  label?: string | number;
  format: (v: number, name?: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="ov-tip">
      {label != null && label !== "" && <div className="ov-tip-title">{String(label)}</div>}
      {payload.map((p, i) => (
        <div key={i}>
          <span className="ov-swatch" style={{ background: p.color }} /> {p.name}:{" "}
          <b>{p.value == null ? "—" : format(p.value, p.name)}</b>
        </div>
      ))}
    </div>
  );
}

function SovDonut({ slices }: { slices: ReturnType<typeof sovSlices> }) {
  if (!slices.length) return <div className="empty">No posts in this period.</div>;
  const fill = (k: string) => (k === "montra" ? C.montra : k === "others" ? C.others : C.compFill);
  const montra = slices.find((s) => s.kind === "montra");
  return (
    <div className="ov-donut">
      <div className="ov-donut-chart">
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie
              data={slices}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="92%"
              startAngle={90}
              endAngle={-270}
              stroke={C.surface}
              strokeWidth={2}
              isAnimationActive={false}
            >
              {slices.map((s) => (
                <Cell key={s.name} fill={fill(s.kind)} />
              ))}
            </Pie>
            <Tooltip
              content={(p) => (
                <ChartTip
                  {...(p as object)}
                  label=""
                  format={(v) => `${fmtInt(v)} (${fmtPct(v / slices.reduce((a, s) => a + s.value, 0), 1)})`}
                />
              )}
            />
          </PieChart>
        </ResponsiveContainer>
        {montra && (
          <div className="ov-donut-center">
            <b>{fmtPct(montra.share, 1)}</b>
            <span>Resonia</span>
          </div>
        )}
      </div>
      <ul className="ov-legend">
        {slices.map((s) => (
          <li key={s.name} className={s.kind === "montra" ? "montra" : undefined}>
            <span className="ov-swatch" style={{ background: fill(s.kind) }} />
            <span className="ov-legend-name">{s.name}</span>
            <b>{fmtPct(s.share, 1)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PageBars({ rows }: { rows: ReturnType<typeof pageAverages> }) {
  if (!rows.some((r) => r.posts)) return <div className="empty">No posts in this period.</div>;
  const data = rows.map((r) => ({ ...r, label: r.posts ? r.avg : null }));
  const ticks = niceTicks(Math.max(...rows.map((r) => r.avg)));
  return (
    <ResponsiveContainer width="100%" height={Math.max(160, rows.length * 24 + 24)}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 0 }} barCategoryGap={4}>
        <CartesianGrid horizontal={false} stroke={C.grid} />
        <XAxis
          type="number"
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          ticks={ticks}
          domain={[0, ticks.at(-1)!]}
          tickFormatter={(v) => fmtCompact(v)}
        />
        <YAxis type="category" dataKey="name" width={148} tick={AXIS} axisLine={false} tickLine={false} interval={0} />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          content={(p) => {
            const r = (p.payload?.[0]?.payload ?? null) as (typeof data)[number] | null;
            if (!p.active || !r) return null;
            return (
              <div className="ov-tip">
                <div className="ov-tip-title">{r.name}</div>
                {r.posts
                  ? `${fmtInt(Math.round(r.avg))} avg likes + comments · ${r.posts} posts`
                  : "No posts in this period"}
              </div>
            );
          }}
        />
        <Bar
          dataKey="avg"
          name="Avg likes + comments"
          radius={[0, 4, 4, 0]}
          isAnimationActive={false}
          label={{
            position: "right",
            fontSize: 11,
            fill: C.axis,
            formatter: (v: unknown) => (typeof v === "number" && v > 0 ? fmtInt(Math.round(v)) : ""),
          }}
        >
          {data.map((r) => (
            <Cell key={r.id} fill={r.montra ? C.montra : C.compFill} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function ThemeBars({ rows }: { rows: ReturnType<typeof themeShares> }) {
  if (!rows.length) return <div className="empty">No posts in this period.</div>;
  const ticks = niceTicks(Math.max(...rows.flatMap((r) => [r.montra, r.comp])));
  return (
    <ResponsiveContainer width="100%" height={Math.max(200, rows.length * 44 + 56)}>
      <BarChart
        data={rows}
        layout="vertical"
        margin={{ top: 0, right: 16, bottom: 0, left: 0 }}
        barGap={2}
        barCategoryGap={10}
      >
        <CartesianGrid horizontal={false} stroke={C.grid} />
        <XAxis
          type="number"
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          ticks={ticks}
          domain={[0, ticks.at(-1)!]}
          tickFormatter={(v) => `${Math.round(v * 100)}%`}
        />
        <YAxis type="category" dataKey="theme" width={132} tick={AXIS} axisLine={false} tickLine={false} interval={0} />
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          content={(p) => <ChartTip {...(p as object)} format={(v) => fmtPct(v, 0)} />}
        />
        <Legend
          iconType="circle"
          iconSize={8}
          wrapperStyle={{ fontSize: 12 }}
          formatter={(v) => <span className="ov-legend-text">{v}</span>}
          itemSorter={(i) => (i.value === "Resonia" ? 0 : 1)}
        />
        <Bar dataKey="montra" name="Resonia" fill={C.montra} radius={[0, 4, 4, 0]} isAnimationActive={false} />
        <Bar dataKey="comp" name="Competitors" fill={C.compFill} radius={[0, 4, 4, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function DailyLine({ rows }: { rows: ReturnType<typeof dailyEngagement> }) {
  if (!rows.some((r) => r.montra || r.comp)) return <div className="empty">No posts in these 30 days.</div>;
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={C.grid} />
        <XAxis
          dataKey="date"
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          tickFormatter={shortDay}
          interval="preserveStartEnd"
          minTickGap={24}
        />
        <YAxis tick={AXIS} axisLine={false} tickLine={false} width={40} tickFormatter={(v) => fmtCompact(v)} />
        <Tooltip
          content={(p) => (
            <ChartTip
              {...(p as object)}
              label={p.label ? shortDay(String(p.label)) : ""}
              format={(v) => fmtInt(Math.round(v))}
            />
          )}
        />
        <Legend
          iconType="plainline"
          wrapperStyle={{ fontSize: 12 }}
          formatter={(v) => <span className="ov-legend-text">{v}</span>}
          itemSorter={(i) => (String(i.value).includes("Resonia") ? 0 : 1)}
        />
        <Line
          type="monotone"
          dataKey="comp"
          name="Average competitor page"
          stroke={C.compLine}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
        <Line
          type="monotone"
          dataKey="montra"
          name="Average Resonia page"
          stroke={C.montra}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
