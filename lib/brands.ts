import brandsJson from "@/brands.json";

// In Resonia Pulse a "page" is one brand on one platform (Resonia on LinkedIn, Resonia on Instagram,
// and so on), and its segment is that platform. The segment chips on the dashboard therefore filter
// by platform, and every page-level figure (followers, posts, engagement rate) stays per platform.
export type Segment = "linkedin" | "instagram" | "facebook" | "x";
export const PLATFORMS: Segment[] = ["linkedin", "instagram", "facebook", "x"];
export const PLATFORM_LABEL: Record<Segment, string> = {
  linkedin: "LinkedIn",
  instagram: "Instagram",
  facebook: "Facebook",
  x: "X",
};

export type Brand = {
  slug: string; // unique page id, e.g. "resonia-li"; also the brands.id in the database
  name: string; // the brand, e.g. "Resonia" (the same on every platform)
  linkedin_url: string; // the page's URL on its platform (the column name is kept from Resonia Pulse)
  handle?: string; // Instagram or X username, without the @
  segment: Segment; // the platform
  is_montra: boolean; // true = Resonia's own page (the field name is kept from Resonia Pulse)
  max_posts: number; // latest posts to fetch per sync
  sync_every_days: number; // 1 = daily, 5 = every 5 days
  track_comments?: boolean; // never set here: Resonia Pulse tracks brand posts only
};

export const BRANDS = brandsJson as Brand[];

// The ORM steps of Resonia Pulse (comments, X mentions, LinkedIn mentions) are switched off:
// Resonia Pulse is for content insights only.
export const ORM_ENABLED = false;
// Montra Pulse's reach, monthly deck and LinkedIn analytics uploads need the page admin's own LinkedIn
// exports, which a pitch team does not have. Switched off until the account is won.
export const LI_EXPORTS_ENABLED = false;

export const COMMENT_BRANDS = BRANDS.filter((b) => b.track_comments);

// Every page's posts from this IST day on were collected once by scripts/backfill.ts.
export const POSTS_BACKFILLED_FROM = "2026-05-24";
export const POST_SAVING = { until: "2000-01-01", competitors: 4, montra: 5 };

// Posts to fetch for a page on an IST calendar day (YYYY-MM-DD).
export function postsToFetch(b: Brand, istDay: string): number {
  if (istDay <= POST_SAVING.until)
    return Math.min(b.max_posts, b.is_montra ? POST_SAVING.montra : POST_SAVING.competitors);
  return b.max_posts;
}
