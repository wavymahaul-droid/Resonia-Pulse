"use client";

import { RANGE_OPTIONS, customRange, presetRange, type DateRange, type RangeKey } from "@/lib/range";

// One date-range picker for the whole dashboard: quick options, and From–To dates that switch to
// "Custom" when edited. `buttons` adds one-click buttons (the Overview keeps 7 / 30 / 90 days).
export function RangePicker({
  range,
  today,
  onChange,
  buttons = [],
}: {
  range: DateRange;
  today: string;
  onChange: (r: DateRange) => void;
  buttons?: { key: Exclude<RangeKey, "custom">; label: string }[];
}) {
  const pick = (key: RangeKey) => onChange(key === "custom" ? { ...range, key: "custom" } : presetRange(key, today));
  return (
    <div className="range-picker" role="group" aria-label="Date range">
      {buttons.length > 0 && (
        <div className="seg">
          {buttons.map((b) => (
            <button key={b.key} aria-pressed={range.key === b.key} onClick={() => pick(b.key)}>
              {b.label}
            </button>
          ))}
        </div>
      )}
      <select
        className="select"
        aria-label="Quick range"
        value={range.key}
        onChange={(e) => pick(e.target.value as RangeKey)}
      >
        {RANGE_OPTIONS.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <label className="date-field">
        From
        <input
          type="date"
          className="select"
          value={range.from}
          max={today}
          onChange={(e) => e.target.value && onChange(customRange(e.target.value, range.to, today))}
        />
      </label>
      <label className="date-field">
        To
        <input
          type="date"
          className="select"
          value={range.to}
          max={today}
          onChange={(e) => e.target.value && onChange(customRange(range.from, e.target.value, today))}
        />
      </label>
    </div>
  );
}
