"use client";

// The Followers section of the Overview: new followers per day for each Resonia page this month,
// with today / yesterday / this week / month to date / total, and a pace check. Page-level
// figures only (no comments, no people), so it is the same in the signed-in and the public view.
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import targets from "@/config/follower-targets.json";
import type { FollowerPoint, LiPageDay } from "@/lib/dashboard";
import { followerRows, type DayGain, type FollowerRow, type PeriodGain } from "@/lib/followerDaily";
import { fmtInt } from "@/lib/metrics";
import { DECK_PAGES } from "@/lib/monthly";
import { shiftDay } from "@/lib/range";

const PAGES = DECK_PAGES.map((p) => ({ id: p.id as string, label: p.short as string }));
const TARGETS = targets as unknown as Record<string, number | null>;
// Round axis steps (1, 2, 2.5 or 5 x a power of ten), about 3 of them.
function niceTicks(max: number, count = 3): number[] {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag);
  const top = Math.ceil(max / step - 1e-9) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}
const AXIS = { fontSize: 11, fill: "var(--c-axis)" };

const longDay = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
const monthName = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
const signed = (n: number) => (n < 0 ? `−${fmtInt(-n)}` : fmtInt(n));

function day(d: DayGain) {
  if (d.value == null)
    return (
      <span className="fl-gap" title="No data for this day">
        no data
      </span>
    );
  return d.source === "estimate" ? (
    <span title="Estimate: change in our daily follower count">~{signed(d.value)}</span>
  ) : (
    <span title="LinkedIn Followers export">{signed(d.value)}</span>
  );
}
function period(p: PeriodGain) {
  if (p.value == null)
    return (
      <span className="fl-gap" title="No data for this period">
        no data
      </span>
    );
  const note = [
    p.estimated ? "Includes estimates from our daily follower count" : "LinkedIn Followers export",
    p.missingDays ? `${p.missingDays} of ${p.days} days have no data` : "",
  ]
    .filter(Boolean)
    .join("; ");
  return (
    <span title={note}>
      {p.estimated ? "~" : ""}
      {signed(p.value)}
      {p.missingDays ? <span className="fn-mark">*</span> : null}
    </span>
  );
}

export default function FollowersSection({
  days,
  followers,
  today,
}: {
  days: LiPageDay[];
  followers: FollowerPoint[];
  today: string;
}) {
  const rows = useMemo(
    () => followerRows({ pages: PAGES, days, followers, today, targets: TARGETS }),
    [days, followers, today],
  );
  const anyTarget = rows.some((r) => r.target);
  const anyMissing = rows.some((r) => r.mtd.missingDays || r.week.missingDays || r.lastMonthSamePoint.missingDays);
  const gapDays =
    rows
      .find((r) => r.id === "all")
      ?.chart.filter((d) => d.value == null)
      .map((d) => d.date) ?? [];
  const dom = Number(today.slice(8, 10));

  return (
    <section className="ov-section" aria-label="Followers">
      <div className="ov-head">
        <h2>Followers</h2>
        <span className="muted small">New followers per day, {monthName(today)}</span>
      </div>
      <div className="fl-legend" aria-hidden>
        <span>
          <i className="fl-key" /> LinkedIn export
        </span>
        <span>
          <i className="fl-key est" /> ~ estimate (change in our daily count)
        </span>
        <span>
          <i className="fl-key gap" /> no data
        </span>
      </div>
      <div className="fl-charts">
        {rows.map((r) => (
          <div className={`ov-card fl-chart${r.id === "all" ? " all" : ""}`} key={r.id}>
            <h3>{r.label}</h3>
            <p className="ov-sub">
              {r.mtd.value == null
                ? "No data this month"
                : `${r.mtd.estimated ? "~" : ""}${signed(r.mtd.value)} this month so far`}
            </p>
            <DayBars row={r} today={today} />
          </div>
        ))}
      </div>

      <div className="ov-card fl-table-card">
        <div className="table-scroll">
          <table className="fl-table">
            <thead>
              <tr>
                <th>Page</th>
                <th>Today</th>
                <th>Yesterday</th>
                <th>This week</th>
                <th>Month to date</th>
                <th>Same point last month</th>
                <th>Projected month end</th>
                {anyTarget && <th>Target</th>}
                <th>Total followers</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={r.id === "all" ? "fl-all" : undefined}>
                  <th scope="row">{r.label}</th>
                  <td>{day(r.today)}</td>
                  <td>{day(r.yesterday)}</td>
                  <td>{period(r.week)}</td>
                  <td>
                    {period(r.mtd)} <Delta now={r.mtd} then={r.lastMonthSamePoint} />
                  </td>
                  <td>{period(r.lastMonthSamePoint)}</td>
                  <td>{r.projected == null ? <span className="fl-gap">no data</span> : `~${signed(r.projected)}`}</td>
                  {anyTarget && (
                    <td>
                      {r.target ? (
                        <>
                          {fmtInt(r.target)}{" "}
                          {r.pace && (
                            <span className={`fl-pace ${r.pace === "behind" ? "behind" : "ok"}`}>
                              {r.pace === "behind" ? "▼ Behind" : "✓ On track"}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="muted">not set</span>
                      )}
                    </td>
                  )}
                  <td>
                    {r.total == null ? <span className="fl-gap">no data</span> : fmtInt(r.total)}
                    {r.totalAsOf && r.totalAsOf !== today && (
                      <span className="muted small"> · {longDay(r.totalAsOf)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fl-foot">
          Each day uses LinkedIn&apos;s own number from the uploaded Followers export where there is one; otherwise the
          change in our daily follower count, marked ~ (an estimate, net of unfollows). A day with neither is shown as
          no data, never as zero
          {gapDays.length
            ? ` (this month: ${gapDays.map(longDay).join(", ")}; uploading the Followers export fills them)`
            : ""}
          . This week runs from Monday. Same point last month is day 1 to day {dom} of last month. Projected month end
          assumes the rest of the month runs at this month&apos;s daily average.
          {anyMissing ? " * Some days in the period have no data." : ""}
          {anyTarget ? "" : " No monthly targets are set."}
        </p>
      </div>
    </section>
  );
}

function Delta({ now, then }: { now: PeriodGain; then: PeriodGain }) {
  if (now.value == null || then.value == null || then.value <= 0) return null;
  const pct = (now.value - then.value) / then.value;
  return (
    <span className="muted small" title="Against the same point last month">
      {pct >= 0 ? "▲" : "▼"} {Math.abs(pct * 100).toFixed(0)}%
    </span>
  );
}

function DayBars({ row, today }: { row: FollowerRow; today: string }) {
  const [y, m] = today.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const month = today.slice(0, 8);
  // The whole month on the axis, so the days still to come are visible as room left.
  const data = Array.from({ length: last }, (_, i) => {
    const date = `${month}${String(i + 1).padStart(2, "0")}`;
    const d = row.chart[i];
    return { date, dom: i + 1, value: d?.value ?? null, source: d?.source ?? null, future: date > today };
  });
  const values = data.map((d) => d.value).filter((v): v is number => v != null);
  if (!values.length) return <div className="empty">No follower data this month yet.</div>;
  // Round axis steps from zero; a month with a net loss on some day keeps the automatic axis.
  const ticks = Math.min(...values) >= 0 ? niceTicks(Math.max(...values, 1)) : null;
  // Runs of days up to today without data, drawn as a grey band.
  const gaps: [number, number][] = [];
  for (const d of data) {
    if (d.future || d.value != null) continue;
    const g = gaps.at(-1);
    if (g && g[1] === d.dom - 1) g[1] = d.dom;
    else gaps.push([d.dom, d.dom]);
  }
  return (
    <ResponsiveContainer width="100%" height={150}>
      <BarChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 0 }} barCategoryGap={2}>
        <CartesianGrid vertical={false} stroke="var(--c-grid)" />
        <XAxis
          dataKey="dom"
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          ticks={[1, 5, 10, 15, 20, 25, last]}
          interval={0}
        />
        <YAxis
          tick={AXIS}
          axisLine={false}
          tickLine={false}
          width={34}
          allowDecimals={false}
          {...(ticks ? { ticks, domain: [0, ticks[ticks.length - 1]] } : { tickCount: 4 })}
        />
        {gaps.map(([a, b]) => (
          <ReferenceArea
            key={a}
            x1={a}
            x2={b}
            fill="var(--c-comp-fill)"
            fillOpacity={0.35}
            stroke="none"
            ifOverflow="visible"
          />
        ))}
        <Tooltip
          cursor={{ fill: "var(--surface-2)" }}
          content={(p) => {
            const d = (p.payload?.[0]?.payload ?? null) as (typeof data)[number] | null;
            if (!p.active || !d) return null;
            return (
              <div className="ov-tip">
                <div className="ov-tip-title">{longDay(d.date)}</div>
                {d.future
                  ? "Still to come"
                  : d.value == null
                    ? "No data for this day"
                    : d.source === "estimate"
                      ? `~${signed(d.value)} new followers (estimate)`
                      : `${signed(d.value)} new followers (LinkedIn export)`}
              </div>
            );
          }}
        />
        <Bar dataKey="value" name="New followers" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((d) => (
            <Cell key={d.date} fill="var(--c-montra)" fillOpacity={d.source === "estimate" ? 0.45 : 1} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
