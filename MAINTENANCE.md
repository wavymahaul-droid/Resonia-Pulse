# Keeping Resonia Pulse running

Plain-language notes for the team. Technical detail is in README.md.

## A sync warning appears on the dashboard

- **"Apify usage this month is above the limit"**: the free $5 credit is nearly used. Wait for the Apify billing cycle to reset, or raise `APIFY_MONTHLY_BUDGET_USD` in Vercel if the account has more credit.
- **"No posts returned for: …"**: that page answered with nothing. Open the page in a browser. If it was renamed, deleted or made private, update its URL or `handle` in `brands.json`. One empty day is normal; three in a row means something changed.
- **"APIFY_TOKEN is set but empty"**: paste the Apify token again in Vercel's environment variables (Production) and redeploy.
- **"Database schema is out of date"**: paste `supabase/schema.sql` into the Supabase SQL editor again and run it. It is safe to re-run.

## Adding or removing a page

Edit `brands.json`. Each line is one brand on one platform: `slug` (unique, e.g. `tatapower-li`), `name` ("Tata Power · LinkedIn"), `linkedin_url` (the page URL on its platform), `handle` (Instagram or X username, no @), `segment` (`linkedin`, `instagram`, `facebook` or `x`), `is_montra` (true only for Resonia's own pages), `max_posts` and `sync_every_days`. To bring a new page's history in, run `npm run backfill -- --go` with the page in the list (pages already backfilled only add what is new).

## Changing themes

Edit `themes.json`. The next sync re-tags stored posts; `npm run retag` does it at once. Themes set by hand on the dashboard are kept.
