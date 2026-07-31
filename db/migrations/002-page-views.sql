-- Visitor statistics, recorded by the site itself.
--
-- Deliberately cookieless. Nothing identifying is stored: no IP address, no
-- user agent, no cookie, no advertising identifier. The "visitor" column is a
-- one-way hash of (secret salt + today's date + IP + user agent), truncated,
-- and the date is part of the input so today's hash cannot be matched against
-- yesterday's. It exists only to stop one person refreshing a page five times
-- counting as five visitors.
--
-- Because there is no cookie and no personal data retained, the site needs no
-- cookie banner.
--
-- Apply locally:  npx wrangler d1 execute shaws-carpentry --local  --file=db/migrations/002-page-views.sql
-- Apply remotely: npx wrangler d1 execute shaws-carpentry --remote --file=db/migrations/002-page-views.sql

CREATE TABLE IF NOT EXISTS page_views (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,                     -- YYYY-MM-DD, UTC
  path       TEXT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'direct',    -- referring site, or 'direct'
  visitor    TEXT NOT NULL,                     -- daily one-way hash, see above
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_page_views_day ON page_views (day);
CREATE INDEX IF NOT EXISTS idx_page_views_source ON page_views (day, source);
CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views (day, visitor);
