// Keyword-based comment sentiment for ORM. The rules live in sentiment.json (see its _help notes).
import config from "@/sentiment.json";
import { toPattern } from "@/lib/themes";

type Rule = {
  sentiment: string;
  matchers: ((text: string) => boolean)[];
  unless: ((text: string) => boolean)[]; // any match skips the rule
  linksExcept: string[] | null; // a link to any other site matches
  questionMark: boolean;
};

type RuleConfig = { sentiment: string; keywords: string[]; unless?: string[]; links_except?: string[]; question_mark?: boolean };

export const FALLBACK_SENTIMENT: string = config.fallback;
export const SENTIMENTS: string[] = [...config.rules.map((r) => r.sentiment), FALLBACK_SENTIMENT];
const NEEDS_RESPONSE = new Set<string>(config.needs_response);

// Words and phrases match whole words (see toPattern). Keywords with no letters or
// digits, such as emoji, match anywhere: "Great👏" has no space before the emoji.
function matcher(keyword: string): (text: string) => boolean {
  const word = keyword.replace(/\*$/, "");
  if (!/[\p{L}\p{N}]/u.test(word)) return (text) => text.includes(word);
  const re = toPattern(keyword);
  return (text) => re.test(text);
}

const RULES: Rule[] = (config.rules as RuleConfig[]).map((r) => ({
  sentiment: r.sentiment,
  matchers: r.keywords.map(matcher),
  unless: (r.unless ?? []).map(matcher),
  linksExcept: r.links_except ?? null,
  questionMark: r.question_mark === true,
}));

// True when the text links to a site outside `allowed` (subdomains of an allowed site are fine).
function hasOtherLink(text: string, allowed: string[]): boolean {
  for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)([^\s/?#]+)/gi)) {
    const host = m[1].toLowerCase().replace(/^www\./, "");
    if (!allowed.some((a) => host === a || host.endsWith(`.${a}`))) return true;
  }
  return false;
}

// The first rule (in sentiment.json order) with a matching keyword wins.
export function tagSentiment(raw: string | null | undefined): string {
  if (!raw) return FALLBACK_SENTIMENT;
  const text = raw.normalize("NFKC");
  for (const rule of RULES) {
    if (rule.unless.some((m) => m(text))) continue;
    if (rule.matchers.some((m) => m(text))) return rule.sentiment;
    if (rule.linksExcept && hasOtherLink(text, rule.linksExcept)) return rule.sentiment;
    if (rule.questionMark && /[?？]/.test(text)) return rule.sentiment;
  }
  return FALLBACK_SENTIMENT;
}

// Comments written by the page itself never need a response.
export function needsResponse(sentiment: string, isPageReply: boolean): boolean {
  return !isPageReply && NEEDS_RESPONSE.has(sentiment);
}
