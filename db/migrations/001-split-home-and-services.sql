-- Give the home page and the services page independent switches.
--
-- Before this, a service had to be on the services page before it could be
-- featured on the home page, because "featured" was filtered by "published".
-- Now the two are separate:
--
--   show_on_home     -> appears in the home page grid
--   show_on_services -> appears on the services page AND in the enquiry
--                       form's dropdown
--
-- Off for both means the service is not on the site anywhere. A service set
-- to home only is deliberately kept out of the dropdown: customers should not
-- be offered something with no page describing it.
--
-- Renaming rather than rebuilding keeps the existing rows and their ordering,
-- and avoids a moment where the live pages would render empty.
--
-- Apply locally:  npx wrangler d1 execute shaws-carpentry --local  --file=db/migrations/001-split-home-and-services.sql
-- Apply remotely: npx wrangler d1 execute shaws-carpentry --remote --file=db/migrations/001-split-home-and-services.sql

ALTER TABLE services RENAME COLUMN featured TO show_on_home;
ALTER TABLE services RENAME COLUMN published TO show_on_services;

DROP INDEX IF EXISTS idx_services_listing;
DROP INDEX IF EXISTS idx_services_featured;

CREATE INDEX idx_services_on_services ON services (show_on_services, category, sort_order);
CREATE INDEX idx_services_on_home ON services (show_on_home, sort_order);
