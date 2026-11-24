// Video insights pilot: picks recent video posts, defines what Gemini is asked for, and checks its
// answer. Pure (no network); the runner is scripts/video-pilot.ts. Not used by any cron.

export type Platform = "linkedin" | "x";

export type VideoCandidate = {
  postId: string; // LinkedIn activity id or tweet id
  postUrl: string;
  platform: Platform;
  page: string; // brands.json id, or "x:MontraElectric"
  montra: boolean;
  mention?: boolean; // someone else's post that mentions Resonia (page "mention:linkedin" / "mention:x")
  postedAt: string;
  caption: string;
  videoUrl: string | null; // a direct link from the saved Apify data, if any
  videoUrlExpires: string | null; // ISO date LinkedIn's link stops working
  thumbnailUrl: string | null;
};

// Indian scripts (Devanagari to Sinhala), for "prefer Hindi or regional-language captions".
export const INDIC = /[ऀ-෿]/;
export const hasIndicCaption = (c: Pick<VideoCandidate, "caption">) => INDIC.test(c.caption);

const firstLine = (s: string) => (s.split("\n").find((l) => l.trim()) ?? "").trim().toLowerCase();
const newest = (a: VideoCandidate, b: VideoCandidate) => b.postedAt.localeCompare(a.postedAt);

// Up to `comp` competitor videos (Indian-language captions first, then the newest) and up to `montra`
// Resonia videos. A video posted on several pages with the same caption counts once per platform, and
// Resonia's picks alternate LinkedIn / X so both fetch paths are tried.
export function selectCandidates(all: VideoCandidate[], { comp = 6, montra = 4 } = {}): VideoCandidate[] {
  const distinct = (list: VideoCandidate[]) => {
    const seen = new Set<string>();
    return list.filter((c) => {
      const k = `${c.platform}|${firstLine(c.caption).slice(0, 80)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };
  const comps = distinct(all.filter((c) => !c.montra).sort(newest));
  const indic = comps.filter(hasIndicCaption);
  const pickedComp = [...indic, ...comps.filter((c) => !hasIndicCaption(c))].slice(0, comp);

  const own = distinct(all.filter((c) => c.montra).sort(newest));
  const li = own.filter((c) => c.platform === "linkedin");
  const x = own.filter((c) => c.platform === "x");
  const pickedOwn: VideoCandidate[] = [];
  for (let i = 0; pickedOwn.length < montra && (i < li.length || i < x.length); i++) {
    for (const c of [li[i], x[i]]) if (c && pickedOwn.length < montra) pickedOwn.push(c);
  }
  return [...pickedComp.sort(newest), ...pickedOwn.sort(newest)];
}

// ---------- Gemini ----------

// The newest stable "gemini-<version>-flash" model the key can call; else the newest Flash preview.
// Lite, live, TTS, image and audio variants are left out. GEMINI_MODEL overrides this.
export function pickFlashModel(models: { name: string; supportedGenerationMethods?: string[] }[]): string | null {
  const usable = models.filter((m) => m.supportedGenerationMethods?.includes("generateContent"));
  const version = (n: string) => Number(n.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
  const pick = (re: RegExp) =>
    usable
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => re.test(n) && !/lite|live|tts|image|audio|thinking|embedding/.test(n))
      .sort((a, b) => version(b) - version(a) || a.length - b.length)[0] ?? null;
  return pick(/^gemini-\d+(?:\.\d+)?-flash$/) ?? pick(/^gemini-\d+(?:\.\d+)?-flash(-preview.*)?$/);
}

export const VIDEO_PROMPT = `You are analysing a short social media video posted on LinkedIn or X by an Indian commercial-vehicle or electric-mobility company.
Watch the whole video, including its audio track and any text shown on screen. Return JSON only, with these fields:
- language_detected: the main spoken language (e.g. "Hindi", "Marathi", "English", "Hinglish", "Tamil"); "none" if there is no speech.
- transcript_original: everything that is spoken, verbatim, in the original language and script (Devanagari for Hindi/Marathi, etc.). Empty string if there is no speech. Do not translate here; do not invent words you cannot hear: write [inaudible] instead.
- transcript_english: a faithful English translation of transcript_original (the same text if it is already English). Empty string if there is no speech.
- on_screen_text: text shown on screen (captions, titles, supers), in its original language, separated by " | ".
- summary_english: two short lines on what the video shows and says.
- brands_mentioned: brands and products named or clearly shown (for example Resonia, Resonia Rhino, EVIATOR, Super Auto, Tata Motors, Eicher, Mahindra, Euler, Switch, TAFE, Blue Energy Motors). Empty list if none.
- tone: "positive", "neutral" or "negative".
- has_speech: true if a person speaks (a voice-over counts); false for music-only or silent videos.
- confidence: "high", "medium" or "low" for the transcript, and confidence_reason: one line explaining why (audio quality, music over speech, dialect, overlapping voices...).`;

// Gemini's structured-output schema (OpenAPI subset).
export const VIDEO_SCHEMA = {
  type: "OBJECT",
  properties: {
    language_detected: { type: "STRING" },
    transcript_original: { type: "STRING" },
    transcript_english: { type: "STRING" },
    on_screen_text: { type: "STRING" },
    summary_english: { type: "STRING" },
    brands_mentioned: { type: "ARRAY", items: { type: "STRING" } },
    tone: { type: "STRING", enum: ["positive", "neutral", "negative"] },
    has_speech: { type: "BOOLEAN" },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
    confidence_reason: { type: "STRING" },
  },
  required: [
    "language_detected",
    "transcript_original",
    "transcript_english",
    "on_screen_text",
    "summary_english",
    "brands_mentioned",
    "tone",
    "has_speech",
    "confidence",
    "confidence_reason",
  ],
} as const;

export type VideoResult = {
  language_detected: string;
  transcript_original: string;
  transcript_english: string;
  on_screen_text: string;
  summary_english: string;
  brands_mentioned: string[];
  tone: "positive" | "neutral" | "negative";
  has_speech: boolean;
  confidence: "high" | "medium" | "low";
  confidence_reason: string;
};

// Checks Gemini's JSON (it can wrap it in ```json fences); anything missing or off-list becomes a
// safe default, and the problems are returned so the run can report them.
export function parseVideoResult(text: string): { result: VideoResult; problems: string[] } {
  const problems: string[] = [];
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ""));
  } catch {
    problems.push("answer was not valid JSON");
  }
  const str = (k: string) => {
    const v = raw[k];
    if (typeof v === "string") return v.trim();
    if (v != null) problems.push(`${k} was not text`);
    else problems.push(`${k} missing`);
    return v == null ? "" : String(v);
  };
  const oneOf = <T extends string>(k: string, allowed: readonly T[], fallback: T): T => {
    const v = String(raw[k] ?? "").toLowerCase() as T;
    if (allowed.includes(v)) return v;
    problems.push(`${k} "${raw[k] ?? ""}" not one of ${allowed.join("/")}`);
    return fallback;
  };
  const brands = Array.isArray(raw.brands_mentioned)
    ? [...new Set(raw.brands_mentioned.map((b) => String(b).trim()).filter(Boolean))]
    : (problems.push("brands_mentioned was not a list"), []);
  const transcript = str("transcript_original");
  return {
    result: {
      language_detected: str("language_detected") || "unknown",
      transcript_original: transcript,
      transcript_english: str("transcript_english"),
      on_screen_text: str("on_screen_text"),
      summary_english: str("summary_english"),
      brands_mentioned: brands,
      tone: oneOf("tone", ["positive", "neutral", "negative"] as const, "neutral"),
      has_speech: typeof raw.has_speech === "boolean" ? raw.has_speech : transcript.length > 0,
      confidence: oneOf("confidence", ["high", "medium", "low"] as const, "low"),
      confidence_reason: str("confidence_reason"),
    },
    problems,
  };
}

// Indian languages Sarvam handles (for the optional comparison).
export const isIndianLanguage = (lang: string) =>
  /hindi|hinglish|marathi|bengali|bangla|tamil|telugu|kannada|malayalam|gujarati|punjabi|odia|oriya|assamese|urdu/i.test(
    lang,
  );

// The row saved to video_transcripts (cleaned by safeWrite / sanitise before writing).
export type TranscriptRow = {
  post_id: string;
  post_url: string;
  platform: Platform;
  page: string;
  posted_at: string;
  thumbnail_url: string | null;
  language_detected: string | null;
  transcript_original: string | null;
  transcript_english: string | null;
  on_screen_text: string | null;
  summary_english: string | null;
  brands_mentioned: string[];
  tone: string | null;
  has_speech: boolean | null;
  confidence: string | null;
  confidence_reason: string | null;
  engine: string; // "gemini:<model>" or "sarvam:<model>"
  tokens_in: number | null;
  tokens_out: number | null;
};

export function geminiRow(
  c: VideoCandidate,
  r: VideoResult,
  model: string,
  usage: { in: number | null; out: number | null },
): TranscriptRow {
  return {
    post_id: c.postId,
    post_url: c.postUrl,
    platform: c.platform,
    page: c.page,
    posted_at: c.postedAt,
    thumbnail_url: c.thumbnailUrl,
    language_detected: r.language_detected,
    transcript_original: r.transcript_original,
    transcript_english: r.transcript_english,
    on_screen_text: r.on_screen_text,
    summary_english: r.summary_english,
    brands_mentioned: r.brands_mentioned,
    tone: r.tone,
    has_speech: r.has_speech,
    confidence: r.confidence,
    confidence_reason: r.confidence_reason,
    engine: `gemini:${model}`,
    tokens_in: usage.in,
    tokens_out: usage.out,
  };
}
