// Keyword-based theme tagging. The rules live in themes.json (see its _help notes).
import config from "@/themes.json";
import type { SupabaseClient } from "@supabase/supabase-js";

type Rule = { theme: string; patterns: RegExp[] };

export const FALLBACK_THEME: string = config.fallback;
export const THEMES: string[] = [...config.themes.map((t) => t.theme), FALLBACK_THEME];

// Whole-word match: a keyword may not sit inside a longer word ("ev" vs "every").
// A trailing * lets the word continue ("dealer*" -> "dealership"). \p{M} keeps
// Hindi vowel signs part of the word.
export function toPattern(keyword: string): RegExp {
  const prefix = keyword.endsWith("*");
  const word = (prefix ? keyword.slice(0, -1) : keyword).trim();
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}])${escaped}${prefix ? "" : "(?![\\p{L}\\p{M}\\p{N}])"}`, "iu");
}

const RULES: Rule[] = config.themes.map((t) => ({ theme: t.theme, patterns: t.keywords.map(toPattern) }));

// The theme with the most matching keywords; ties go to the theme listed first.
export function tagTheme(raw: string | null | undefined): string {
  if (!raw) return FALLBACK_THEME;
  // NFKC turns LinkedIn's "fancy" Unicode bold/italic letters (𝐃𝐀𝐘) back into plain text.
  const text = raw.normalize("NFKC");
  let best = FALLBACK_THEME;
  let bestHits = 0;
  for (const rule of RULES) {
    const hits = rule.patterns.filter((p) => p.test(text)).length;
    if (hits > bestHits) {
      best = rule.theme;
      bestHits = hits;
    }
  }
  return best;
}

// Tags posts in the database. By default only posts with no theme yet (so each
// post is tagged once); with all=true every post is re-tagged, e.g. after editing themes.json.
// Posts whose theme was changed by hand on the dashboard (theme_manual) are never touched.
export async function tagPosts(db: SupabaseClient, { all = false } = {}): Promise<number> {
  // theme_manual only exists once supabase/schema.sql has been re-run; before that no post can be manual.
  const hasManual = !(await db.from("posts").select("theme_manual").limit(1)).error;
  const byTheme = new Map<string, string[]>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    let q = db.from("posts").select("post_url,text,theme").order("post_url").range(from, from + PAGE - 1);
    if (!all) q = q.is("theme", null);
    if (hasManual) q = q.eq("theme_manual", false);
    const { data, error } = await q;
    if (error) throw new Error(`posts select: ${error.message}`);
    for (const p of data) {
      const theme = tagTheme(p.text);
      if (theme !== p.theme) byTheme.set(theme, [...(byTheme.get(theme) ?? []), p.post_url]);
    }
    // A sync adds well under 1000 posts; any untagged beyond that are picked up by the next run.
    if (data.length < PAGE || !all) break;
  }
  let tagged = 0;
  for (const [theme, urls] of byTheme) {
    for (let i = 0; i < urls.length; i += 100) {
      const chunk = urls.slice(i, i + 100);
      let q = db.from("posts").update({ theme }).in("post_url", chunk);
      // Guards against a post being edited by hand while the retag runs.
      if (hasManual) q = q.eq("theme_manual", false);
      const { error } = await q;
      if (error) throw new Error(`posts theme update: ${error.message}`);
      tagged += chunk.length;
    }
  }
  return tagged;
}
