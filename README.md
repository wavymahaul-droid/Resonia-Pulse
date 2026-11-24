# Resonia Pulse

Content tracker for Resonia and three transmission peers (IndiGrid, Adani Energy Solutions, POWERGRID) on LinkedIn, Instagram, Facebook and X. Built for the Sterlite NBD pitch, as a fork of Montra Pulse: same dashboard, Insights, Top posts and Report, with the ORM parts (comments, X mentions, LinkedIn mentions, digest, Radar) switched off. Runs on free plans (Vercel Hobby, Supabase Free, Apify Free).

## Pages

`brands.json` lists 13 pages. A page is one brand on one platform, and its `segment` is the platform, so the segment chips on the dashboard filter by platform.

| Brand | LinkedIn | Instagram | Facebook | X |
| --- | --- | --- | --- | --- |
| Resonia | resonia | @resonialimited | profile 61575138148057 | not tracked: @Resonialimited shows "Account suspended" |
| IndiGrid | indigrid | @indigrid.in (small account, not linked from indigrid.co.in: confirm it is official) | none linked from its website | @indigrid_in |
| Adani Energy Solutions | adani-energy-solutions-ltd | @adanienergysolutions | not tracked: its website links the Adani group page | @adanienergysol |
| POWERGRID | powergrid | @pgcilindia | pgcilindia | @pgcilindia |

To add or remove a page, edit `brands.json` (`handle` is the Instagram or X username without the @).

## Data and cost

| Platform | Apify actor (no login, no cookies) | Followers from |
| --- | --- | --- |
| LinkedIn | `harvestapi/linkedin-company-posts` | the posts' author line |
| Instagram | `apify/instagram-post-scraper` | `apify/instagram-profile-scraper` |
| Facebook | `apify/facebook-posts-scraper` (one run per page) | `apify/facebook-pages-scraper` |
| X | `scrape.badger/twitter-tweets-scraper` (`from:<handle> -filter:replies -filter:retweets`) | the tweets' author |

- Instagram, Facebook and X items are turned into the LinkedIn post shape in `lib/platforms.ts`, so the sync, thumbnails, theme tagging and dashboard work the same for every platform. Their post ids are prefixed (`ig-`, `fb-`, `x-`).
- Engagement: likes, comments and reposts/shares. On X, likes, replies and reposts + quotes (views are not stored). Instagram accounts that hide likes count as 0 likes.
- Prices in `lib/platforms.ts` are deliberately high, so spending caps never cut a run short; each run's real cost is read back from Apify and saved in `sync_runs.apify_cost_usd`.
- Use a **new free Apify account**, not Montra Pulse's: Montra's daily sync already uses most of that account's $5 a month.

## Themes

`themes.json` holds transmission-sector themes: Festive & greetings, Projects & commissioning, Awards & recognition, Leadership & strategy, Policy & sector, Technology & innovation, Safety & quality, CSR & community, Hiring & culture, Events & expos, Investors & results, and Other. Edit freely; the next sync re-tags stored posts (or run `npm run retag`). Themes changed by hand on the dashboard are kept.

## Setup

1. Create a Supabase project, paste `supabase/schema.sql` into its SQL editor and run it.
2. Create a free Apify account and copy its API token.
3. Locally (Node 20.6 or newer): `npm install`, then copy `.env.example` to `.env.local` and fill in `APIFY_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CRON_SECRET` and `DASHBOARD_PASSWORD`. The npm scripts read `.env.local` themselves.
4. Check the actors answer: `npm run test:platforms` (a few cents). Every field should say `ok`.
5. Estimate the backfill: `npm run backfill` (prints pages, limits and the worst-case cost against this month's Apify usage; spends nothing).
6. Run it: `npm run backfill -- --go`. If the estimate is above the budget, split it across two billing cycles, e.g. `--go --only linkedin,x,instagram` now and `--go --only facebook` next cycle. `--dry` fetches without writing. Another start day: `npm run backfill -- 2026-06-01 --go`.
7. Deploy to Vercel with the same environment variables, then `npm run dev` locally or open the Vercel URL.

Backfilled posts are stored with `posts.origin = "backfill"`: their likes and comments are the totals on the day the backfill ran, which favours older posts slightly. Post figures are complete from 24 May 2026 (`POSTS_BACKFILLED_FROM` in `lib/brands.ts`).

## Turning on the daily sync later

`vercel.json` has no cron yet. To sync every page daily at 17:00 IST, set it to:

```json
{ "crons": [{ "path": "/api/cron/sync", "schedule": "30 11 * * *" }] }
```

Each page then fetches its latest `max_posts` (Resonia 5, competitors 4). Rough daily cost: about $0.10-0.15 including the Instagram and Facebook follower lookups, so about $3-4.50 a month on the free plan. `npm run sync` runs it once by hand (`-- --dry`, `-- --force`).

## Switched off from Montra Pulse

- `ORM_ENABLED = false` in `lib/brands.ts`: comments, X mentions, LinkedIn mentions, the Comments and X tabs, the ORM digest and the Earned vs owned card.
- `LI_EXPORTS_ENABLED = false`: LinkedIn analytics uploads, reach, organic impression tiles and the monthly deck. They need the page admin's own LinkedIn exports, which a pitch team does not have. Turn on if the account is won.
- The Radar and Talking points pages are removed; the Overview keeps a "Content gaps" card (themes competitors covered that Resonia did not, and the week's best competitor post).

## Dashboard

As in Montra Pulse: one shared password (`DASHBOARD_PASSWORD`), or `PUBLIC_DASHBOARD=true` for a view-only link. Overview, Insights (best time to post, format and theme performance, hashtags), `/top` (top posts overall and per page), `/report` (period summary with copy-as-text and CSV). Date range picker adds "Last 6 months". Engagement rate = (likes + comments) per post ÷ followers. Share of voice = a page's share of all likes + comments in view; use the platform chips to compare like with like.
