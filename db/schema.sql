-- Shaws Carpentry content schema.
--
-- Everything Stuart can edit from /admin lives here. The public pages read
-- from these tables at request time, so a change is live immediately.
--
-- Apply locally:  npx wrangler d1 execute shaws-carpentry --local  --file=db/schema.sql
-- Apply remotely: npx wrangler d1 execute shaws-carpentry --remote --file=db/schema.sql

DROP TABLE IF EXISTS gallery_images;
DROP TABLE IF EXISTS services;
DROP TABLE IF EXISTS gallery;
DROP TABLE IF EXISTS testimonials;
DROP TABLE IF EXISTS settings;

-- Service cards on /services, and the four featured ones on the home page.
CREATE TABLE services (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category    TEXT    NOT NULL CHECK (category IN ('domestic', 'commercial')),
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL,
  image_key   TEXT,
  image_alt   TEXT    NOT NULL DEFAULT '',
  -- Independent switches. A service can appear on the home page, the
  -- services page, both, or neither. show_on_services also governs whether
  -- it is offered in the enquiry form's dropdown.
  show_on_home     INTEGER NOT NULL DEFAULT 0 CHECK (show_on_home IN (0, 1)),
  show_on_services INTEGER NOT NULL DEFAULT 1 CHECK (show_on_services IN (0, 1)),
  sort_order       INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_services_on_services ON services (show_on_services, category, sort_order);
CREATE INDEX idx_services_on_home ON services (show_on_home, sort_order);

-- A project on /gallery. One tile in the grid, but it can hold several
-- photos: the first is the cover, and opening it steps through the rest.
CREATE TABLE gallery (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  caption    TEXT    NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  published  INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0, 1)),
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_gallery_listing ON gallery (published, sort_order);

-- The photos belonging to a gallery project, in display order.
CREATE TABLE gallery_images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  gallery_id INTEGER NOT NULL REFERENCES gallery(id) ON DELETE CASCADE,
  image_key  TEXT    NOT NULL,
  image_alt  TEXT    NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_gallery_images ON gallery_images (gallery_id, sort_order);

-- Customer reviews. While none are published the home page keeps showing the
-- "Reviews coming soon" card, so the site is never left looking unfinished.
CREATE TABLE testimonials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  quote       TEXT    NOT NULL,
  author_name TEXT    NOT NULL,
  author_town TEXT    NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  published   INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_testimonials_listing ON testimonials (published, sort_order);

-- Contact details and areas covered, repeated across all four pages.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
