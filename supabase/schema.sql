-- Resonia Pulse: database schema (forked from Montra Pulse).
-- A page is one brand on one platform; brands.segment is the platform.
-- Paste into the Supabase SQL editor and run once. Safe to re-run.

create table if not exists brands (
  id            text primary key,            -- page id from brands.json, e.g. 'resonia-li'
  name          text not null,
  linkedin_url  text not null unique,         -- the page URL on its platform
  segment       text not null check (segment in ('linkedin', 'instagram', 'facebook', 'x')),
  is_montra     boolean not null default false,  -- true = a Resonia page (name kept from Montra Pulse)
  created_at    timestamptz not null default now()
);

create table if not exists follower_snapshots (
  brand_id   text not null references brands (id) on delete cascade,
  date       date not null,                  -- IST calendar date of the sync
  followers  integer not null,
  primary key (brand_id, date)
);

create table if not exists posts (
  post_url       text primary key,
  brand_id       text not null references brands (id) on delete cascade,
  linkedin_id    text,                       -- LinkedIn activity id
  posted_at      timestamptz,
  text           text,
  media_type     text,                       -- text / image / carousel / video / document / article
  theme          text,                       -- set once by keyword rules in themes.json, or by hand
  first_seen_at  timestamptz not null default now()
);
create index if not exists posts_brand_posted_idx on posts (brand_id, posted_at desc);
create index if not exists posts_posted_idx on posts (posted_at desc);

create table if not exists post_snapshots (
  post_url  text not null references posts (post_url) on delete cascade,
  date      date not null,                   -- IST calendar date of the sync
  likes     integer not null default 0,      -- total reactions (all types)
  comments  integer not null default 0,
  reposts   integer not null default 0,
  primary key (post_url, date)
);

create table if not exists sync_runs (
  id               bigint generated always as identity primary key,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  status           text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  pages_succeeded  integer,
  pages_failed     text[] not null default '{}',  -- brand ids that returned no posts
  posts_saved      integer,
  notes            text
);
create index if not exists sync_runs_started_idx on sync_runs (started_at desc);

-- Added for the per-page schedule and the Apify budget guard. Safe on an existing database.
alter table brands    add column if not exists last_synced_at timestamptz;  -- last run that returned posts for this page
alter table sync_runs add column if not exists pages_attempted text[] not null default '{}';  -- pages that were due
alter table sync_runs add column if not exists apify_cost_usd numeric(10, 4);                  -- what this run cost on Apify
alter table sync_runs drop constraint if exists sync_runs_status_check;
alter table sync_runs add constraint sync_runs_status_check
  check (status in ('running', 'success', 'partial', 'failed', 'skipped'));

-- Added for post thumbnails and hand-edited themes. Safe on an existing database.
alter table posts add column if not exists image_path   text;                           -- object path in the post-images bucket
alter table posts add column if not exists theme_manual boolean not null default false; -- true = set on the dashboard; npm run retag skips it

-- Private bucket for post thumbnails (600px wide WebP). The dashboard reads them through signed URLs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', false, 1048576, array['image/webp'])
on conflict (id) do nothing;

-- Added for comment tracking (ORM) on Montra Electric, Montra Electric Truck and Montra Electric SCV.
-- Safe on an existing database.
create table if not exists comments (
  comment_id          text primary key,           -- LinkedIn comment id
  post_url            text not null references posts (post_url) on delete cascade,
  brand_id            text not null references brands (id) on delete cascade,
  parent_comment_id   text,                       -- set for replies: the comment replied to
  commenter_name      text,
  commenter_headline  text,
  commenter_url       text,
  is_page_reply       boolean not null default false,  -- written by a Montra page; never needs a response
  text                text,
  posted_at           timestamptz,
  reactions           integer not null default 0,
  comment_url         text,                       -- direct link to the comment on LinkedIn
  sentiment           text not null default 'Neutral',  -- one of the sentiments in sentiment.json
  needs_response      boolean not null default false,  -- Negative, Question or Lead (see sentiment.json)
  handled             boolean not null default false,
  handled_at          timestamptz,
  handled_by          text check (handled_by in ('team', 'auto')),  -- auto = a Montra page replied in the thread; team = set by hand (also when un-marked), never changed automatically
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now()
);
create index if not exists comments_post_idx on comments (post_url);
create index if not exists comments_brand_posted_idx on comments (brand_id, posted_at desc);
create index if not exists comments_parent_idx on comments (parent_comment_id);
create index if not exists comments_open_idx on comments (posted_at desc) where needs_response and not handled;

-- Tagged people in the comment text ([{start, length, text}]), masked in the public view.
alter table comments add column if not exists mentions jsonb not null default '[]'::jsonb;

-- Sentiments are defined in sentiment.json, so the database no longer limits them.
alter table comments drop constraint if exists comments_sentiment_check;

-- backfill = an old comment collected by scripts/backfill.ts, marked handled so it does not count as
-- needing a response today.
alter table comments drop constraint if exists comments_handled_by_check;
alter table comments add constraint comments_handled_by_check check (handled_by in ('team', 'auto', 'backfill'));

alter table posts     add column if not exists comments_checked  integer;          -- comment count when comments were last fetched
alter table sync_runs add column if not exists comments_saved    integer;          -- comments and replies stored this run
alter table sync_runs add column if not exists comments_cost_usd numeric(10, 4);   -- comment part of apify_cost_usd

-- Added for X (Twitter) tracking of @MontraElectric. Safe on an existing database.
-- Mentions (tagging us, replying to us, or naming "Montra Electric") and our own posts and replies.
create table if not exists x_tweets (
  tweet_id              text primary key,
  kind                  text not null check (kind in ('mention', 'post', 'reply')),  -- post / reply = by @MontraElectric
  source                text not null default 'search' check (source in ('search', 'own', 'reply_lookup')),  -- reply_lookup = found by id because we replied (X search hid it)
  author_username       text,
  author_name           text,
  author_followers      integer,
  text                  text,
  posted_at             timestamptz,
  url                   text not null,
  in_reply_to_id        text,
  in_reply_to_username  text,
  conversation_id       text,
  tags_us               boolean not null default false,  -- tags or replies to @MontraElectric; false = only names "Montra Electric"
  is_media              boolean not null default false,  -- media or brand page ("Media mention"), flagged only when Negative
  likes                 integer not null default 0,
  replies               integer not null default 0,
  reposts               integer not null default 0,
  quotes                integer not null default 0,
  views                 integer,
  sentiment             text not null default 'Neutral',
  needs_response        boolean not null default false,
  handled               boolean not null default false,
  handled_at            timestamptz,
  handled_by            text check (handled_by in ('team', 'auto')),  -- auto = @MontraElectric replied; team = set by hand (also when un-marked)
  mentions              text[] not null default '{}',  -- handles tagged in the text, masked in the public view
  first_seen_at         timestamptz not null default now(),
  last_seen_at          timestamptz not null default now()
);
create index if not exists x_tweets_posted_idx on x_tweets (posted_at desc);
create index if not exists x_tweets_reply_to_idx on x_tweets (in_reply_to_id);
create index if not exists x_tweets_open_idx on x_tweets (posted_at desc) where needs_response and not handled;

create table if not exists x_follower_snapshots (
  handle     text not null,
  date       date not null,                  -- IST calendar date of the sync
  followers  integer not null,
  primary key (handle, date)
);

alter table sync_runs add column if not exists x_saved    integer;          -- new X mentions and replies stored this run
alter table sync_runs add column if not exists x_cost_usd numeric(10, 4);   -- X part of apify_cost_usd

-- Added for LinkedIn mentions: public posts by others that name Montra Electric or EViator.
-- Safe on an existing database.
create table if not exists linkedin_mentions (
  mention_id       text primary key,                -- LinkedIn activity id
  post_url         text not null,
  author_name      text,
  author_url       text,
  author_type      text,                            -- company / profile
  author_headline  text,                            -- a person's headline; a company's follower count
  text             text,
  posted_at        timestamptz,
  likes            integer not null default 0,
  comments         integer not null default 0,
  reposts          integer not null default 0,
  is_media         boolean not null default false,  -- company page: "Media mention", flagged only when Negative
  is_staff         boolean not null default false,  -- a person whose headline names Montra: never flagged
  sentiment        text not null default 'Neutral',
  needs_response   boolean not null default false,
  handled          boolean not null default false,
  handled_at       timestamptz,
  handled_by       text check (handled_by in ('team', 'auto')),
  mentions         jsonb not null default '[]'::jsonb,  -- tagged people, masked in the public view
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now()
);
create index if not exists linkedin_mentions_posted_idx on linkedin_mentions (posted_at desc);

alter table sync_runs add column if not exists mentions_saved    integer;          -- new LinkedIn mentions stored this run
alter table sync_runs add column if not exists mentions_cost_usd numeric(10, 4);   -- mention part of apify_cost_usd

-- Added for the morning (07:00 IST) and afternoon (13:00 IST) ORM scans. Safe on an existing database.
alter table sync_runs add column if not exists kind text not null default 'evening';  -- morning / afternoon / evening
alter table sync_runs add column if not exists x_status text;          -- success / skipped / failed: X searches start where the last success did
alter table sync_runs add column if not exists mentions_status text;   -- the same for the LinkedIn mention search
alter table sync_runs add column if not exists mentions_fetched integer;  -- posts the mention search returned (and was charged for)
create index if not exists sync_runs_kind_idx on sync_runs (kind, started_at desc);

-- Fill last_synced_at for pages synced before the column existed.
update brands b
set last_synced_at = (s.last_date::timestamp + interval '7 hours') at time zone 'Asia/Kolkata'
from (
  select p.brand_id, max(ps.date) as last_date
  from post_snapshots ps join posts p using (post_url)
  group by p.brand_id
) s
where s.brand_id = b.id and b.last_synced_at is null;

-- Where a post record came from: the daily sync (default), an uploaded LinkedIn analytics export
-- (opening text and date only, no posting time or image), or the one-off backfill of older posts
-- (likes and comments are the totals on the day it ran).
alter table posts add column if not exists origin text not null default 'sync';
-- origin 'ad': an export row that matched no post on the feed and is marked sponsored or has no
-- feed link: a dark post (Direct Sponsored Content), shown as "Ad (not on feed)" and kept out of post
-- stats. is_ad / ad_manual: set by hand with "Mark as organic / ad" (ad_manual wins over origin).
alter table posts add column if not exists is_ad     boolean not null default false;
alter table posts add column if not exists ad_manual boolean not null default false;

-- Latest engagement per post, for the dashboard. Dropped and re-created so new posts columns show up.
drop view if exists post_latest;
create view post_latest as
select distinct on (s.post_url)
  p.*, s.date as snapshot_date, s.likes, s.comments, s.reposts
from posts p
join post_snapshots s using (post_url)
order by s.post_url, s.date desc;

-- Lock tables down: only the server (service role key) reads and writes.
-- No policies are defined, so the public anon key gets nothing.
alter table brands             enable row level security;
alter table follower_snapshots enable row level security;
alter table posts              enable row level security;
alter table post_snapshots     enable row level security;
alter table sync_runs          enable row level security;
alter table comments           enable row level security;
alter table x_tweets           enable row level security;
alter table x_follower_snapshots enable row level security;
alter table linkedin_mentions  enable row level security;
alter view post_latest set (security_invoker = true);

-- LinkedIn page analytics exports uploaded from the dashboard ("Upload LinkedIn analytics").
-- Per-post numbers from the Content export, keyed by the export's post link; post_url is the
-- matching tracked post (null until one matches).
create table if not exists li_post_metrics (
  export_link      text primary key,
  post_url         text references posts (post_url) on delete set null,
  brand_id         text not null references brands (id) on delete cascade,
  created_date     date,
  title            text,
  impressions      integer,
  clicks           integer,
  ctr              numeric(10, 6),          -- 0.0123 = 1.23%
  reactions        integer,
  comments         integer,
  reposts          integer,
  engagement_rate  numeric(10, 6),
  uploaded_at      timestamptz not null default now()
);
create index if not exists li_post_metrics_post_idx on li_post_metrics (post_url);

-- Daily page numbers from the Content (impressions, clicks...), Followers (new followers) and
-- Visitors (page views, unique visitors) exports. Each upload fills the columns its file has.
create table if not exists li_page_metrics (
  brand_id                 text not null references brands (id) on delete cascade,
  date                     date not null,
  impressions              integer,
  unique_impressions       integer,
  clicks                   integer,
  reactions                integer,
  comments                 integer,
  reposts                  integer,
  engagement_rate          numeric(10, 6),
  new_followers            integer,
  new_followers_organic    integer,
  new_followers_sponsored  integer,
  page_views               integer,
  unique_visitors          integer,
  updated_at               timestamptz not null default now(),
  primary key (brand_id, date)
);

-- One row per uploaded file, for "last uploaded" and a record of what was read.
create table if not exists li_uploads (
  id           bigserial primary key,
  brand_id     text references brands (id) on delete cascade,
  file_name    text,
  kinds        text,                         -- content, followers, visitors
  rows_read    integer,
  posts_matched integer,
  posts_unmatched integer,
  date_from    date,
  date_to      date,
  uploaded_at  timestamptz not null default now()
);

alter table li_post_metrics enable row level security;
alter table li_page_metrics enable row level security;
alter table li_uploads      enable row level security;

-- Organic and sponsored numbers kept apart (the plain columns are LinkedIn's totals), so paid
-- campaigns don't inflate organic CTR. Each post row also keeps the export row as read, and whether
-- it was a sponsored (paid) post.
alter table li_page_metrics add column if not exists impressions_organic   integer;
alter table li_page_metrics add column if not exists impressions_sponsored integer;
alter table li_page_metrics add column if not exists clicks_organic        integer;
alter table li_page_metrics add column if not exists clicks_sponsored      integer;
alter table li_page_metrics add column if not exists reactions_organic     integer;
alter table li_page_metrics add column if not exists reactions_sponsored   integer;
alter table li_page_metrics add column if not exists comments_organic      integer;
alter table li_page_metrics add column if not exists comments_sponsored    integer;
alter table li_page_metrics add column if not exists reposts_organic       integer;
alter table li_page_metrics add column if not exists reposts_sponsored     integer;
alter table li_post_metrics add column if not exists post_type  text;      -- "Organic" / "Sponsored" as exported
alter table li_post_metrics add column if not exists sponsored  boolean not null default false;
alter table li_post_metrics add column if not exists raw        jsonb;     -- the export row as read

-- Monthly client report: month-on-month figures per Montra page entered from earlier decks
-- (LinkedIn new followers, engagements, page impressions, posts). Edited on the Report page when
-- signed in; a month entered here is used instead of the uploaded exports. Safe to re-run: the
-- seed rows are only added when missing, so later edits are kept.
create table if not exists report_history (
  brand_id         text not null references brands (id) on delete cascade,
  month            text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),  -- YYYY-MM
  follower_growth  integer,
  engagement       integer,
  impressions      integer,
  posts            integer,
  updated_at       timestamptz not null default now(),
  primary key (brand_id, month)
);
alter table report_history enable row level security;
-- Follower growth filled in from the uploaded Followers exports (LinkedIn's total new followers for a
-- full month). Those are updated by later uploads; figures entered by hand are never overwritten.
alter table report_history add column if not exists follower_growth_from_export boolean not null default false;
-- Rows the fill added before this column existed hold only a follower growth figure: mark them.
update report_history set follower_growth_from_export = true
where follower_growth is not null and engagement is null and impressions is null and posts is null
  and not follower_growth_from_export;
insert into report_history (brand_id, month, follower_growth, engagement, impressions, posts)
select v.* from (values
  ('montraelectric',        '2026-06', 1905,  4994,  40863, 5),
  ('montraelectric',        '2026-07', 1980,  8157, 103356, 6),
  ('montraelectric',        '2026-08', 1486,  1251,  56333, 4),
  ('montraelectrictruck',   '2026-06', 2049,  1622,  34890, 3),
  ('montraelectrictruck',   '2026-07', 2817, 15575, 175543, 7),
  ('montraelectrictruck',   '2026-08', 2043,  1703,  95342, 3),
  ('montra-electric-scv',   '2026-06', 1713, 17995, 504601, 6),
  ('montra-electric-scv',   '2026-07', 1528,  5767, 600468, 2),
  ('montra-electric-scv',   '2026-08', 1476,  1888, 234862, 4),
  ('montraelectrictractor', '2026-06',  190,   294,   3580, 2),
  ('montraelectrictractor', '2026-07',  377,  3801,  48387, 2),
  ('montraelectrictractor', '2026-08',   88,    53,   2658, 1)
) as v (brand_id, month, follower_growth, engagement, impressions, posts)
where exists (select 1 from brands b where b.id = v.brand_id)  -- pages the tracker has set up
on conflict (brand_id, month) do nothing;

-- Industry Radar (/radar): headlines from free RSS feeds (radar.json), fetched by the 7am IST cron.
-- Only the headline, link, source, date and the feed's short snippet are kept, never article text.
-- Items older than radar.json keepDays (60) are removed. note = "Why it matters" (signed-in only).
create table if not exists radar_items (
  url             text primary key,
  title           text not null,
  title_key       text not null,              -- normalised title, for near-duplicate checks
  source          text,
  snippet         text,
  published_at    timestamptz,
  query           text,                       -- the search or feed that found it
  note            text,
  note_updated_at timestamptz,
  first_seen_at   timestamptz not null default now()
);
create index if not exists radar_items_published_idx on radar_items (published_at desc);
alter table radar_items enable row level security;

-- Whether each Radar feed worked on the last fetch (shown on /radar when signed in).
create table if not exists radar_feeds (
  name        text primary key,
  url         text not null,
  ok          boolean not null,
  items       integer not null default 0,
  error       text,
  checked_at  timestamptz not null default now()
);
alter table radar_feeds enable row level security;

-- Rows a sync step could not write (lib/safeWrite.ts). The rest of the step is saved; the bad row is
-- skipped and logged here, and shown under "Sync health (7 days)" on the dashboard (signed in).
-- strikes = runs in a row that refused it; at 3 it is marked permanent and no longer tried.
-- cleared = it saved later, so earlier refusals no longer count.
create table if not exists sync_rejects (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  run_id      bigint,                        -- sync_runs.id (null for Radar and scripts)
  step        text,                          -- posts / comments / x / mentions / radar / backfill
  table_name  text not null,
  source_id   text not null,                 -- the row's id or link
  error       text,
  payload     text,                          -- the first 500 characters of the row
  strikes     integer not null default 1,
  permanent   boolean not null default false,
  cleared     boolean not null default false
);
create index if not exists sync_rejects_source_idx on sync_rejects (table_name, source_id);
create index if not exists sync_rejects_at_idx on sync_rejects (at desc);
alter table sync_rejects enable row level security;

-- Each step's outcome (ok / partial / failed / skipped, rows saved and skipped), for "Sync health".
alter table sync_runs add column if not exists step_stats jsonb;

-- Video insights PILOT (scripts/video-pilot.ts, run by hand; not in any cron). One row per post and
-- engine: Gemini's reading of the whole video, and optionally Sarvam's transcript of Indian-language
-- speech. Shown in the signed-in "Video insights" panel (Insights tab). No video files are ever stored.
create table if not exists video_transcripts (
  post_id              text not null,               -- LinkedIn activity id or tweet id
  post_url             text not null,
  platform             text not null check (platform in ('linkedin', 'x')),
  page                 text not null,               -- brands.json id, or "x:MontraElectric"
  posted_at            timestamptz,
  thumbnail_url        text,                        -- "storage:<path>" (our thumbnail) or a public image URL
  language_detected    text,
  transcript_original  text,
  transcript_english   text,
  on_screen_text       text,
  summary_english      text,
  brands_mentioned     jsonb not null default '[]'::jsonb,
  tone                 text,
  has_speech           boolean,
  confidence           text,
  confidence_reason    text,
  engine               text not null,               -- "gemini:<model>" or "sarvam:<model>"
  tokens_in            integer,
  tokens_out           integer,
  created_at           timestamptz not null default now(),
  primary key (post_id, engine)
);
create index if not exists video_transcripts_posted_idx on video_transcripts (posted_at desc);
alter table video_transcripts enable row level security;
