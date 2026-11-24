// Cleaning applied to every row before it is written to the database, so one odd character in a
// post, comment or tweet can never make Postgres reject a whole batch. Pure; safe in the browser.
//
// Postgres refuses, with "invalid input syntax for type json" or "unsupported Unicode escape
// sequence": the NUL character (\u0000) anywhere, and a lone half of a surrogate pair (half an
// emoji, or half a 𝐛𝐨𝐥𝐝 letter, left behind when a string is cut by UTF-16 position).

// C0 control characters except tab, newline and carriage return; DEL; the two non-characters.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F￾￿]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function cleanString(s: string): string {
  return s.replace(CONTROL, "").replace(LONE_SURROGATE, "");
}

// What cleanString would remove, for logs and tests ("U+DC1B at 0").
export function badCharacters(s: string): string[] {
  const out: string[] = [];
  for (const re of [CONTROL, LONE_SURROGATE]) {
    for (const m of s.matchAll(re)) {
      out.push(`U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} at ${m.index}`);
    }
  }
  return out;
}

// Deep-cleans a value: strings as above; NaN, Infinity, undefined, functions and symbols become
// null; dates become ISO strings; bigints become strings.
export function sanitise(v: unknown): unknown {
  if (typeof v === "string") return cleanString(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Array.isArray(v)) return v.map(sanitise);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as object)) out[cleanString(k)] = sanitise(x);
    return out;
  }
  return null; // undefined, functions, symbols
}

// A row for insert or upsert. Top-level columns that are undefined are left out, so the column's
// default applies (as supabase-js already does); everything else goes through sanitise().
// jsonColumns: json / jsonb columns. A string there that holds JSON text is parsed, so the column
// gets the object rather than a quoted string; the result must survive JSON.stringify.
export function sanitiseRow<T extends Record<string, unknown>>(row: T, jsonColumns: readonly string[] = []): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    let value = v;
    if (jsonColumns.includes(k) && typeof v === "string") {
      try {
        value = JSON.parse(v);
      } catch {
        // Not JSON text: stored as a JSON string.
      }
    }
    out[k] = sanitise(value);
  }
  JSON.stringify(out); // throws on anything Postgres could not read (e.g. a cycle)
  return out as T;
}

// Cuts a string to at most `max` UTF-16 units without splitting a surrogate pair (an emoji or a
// 𝐛𝐨𝐥𝐝 letter). With `ellipsis`, a cut string ends in "…" within the same length.
export function clip(s: string, max: number, ellipsis = false): string {
  if (s.length <= max) return s;
  let end = ellipsis ? max - 1 : max;
  if (end > 0 && /[\uD800-\uDBFF]/.test(s[end - 1])) end--;
  const cut = s.slice(0, end);
  return ellipsis ? `${cut.trimEnd()}…` : cut;
}
