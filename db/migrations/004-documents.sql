-- Quotes, orders and invoices.
--
-- One row per job. It starts as a quote, becomes an order when the customer
-- accepts, and becomes an invoice when the work is done. The type changes on
-- the same row rather than being copied to another table, which is why every
-- reference number it has held is kept: an invoice can still show which quote
-- it began as.
--
-- The task and material breakdown is JSON. Nothing queries inside it: it is
-- read and written whole by one screen, so a pair of extra tables would buy
-- nothing.
--
-- These rows hold customer names, addresses, phone numbers and email
-- addresses. Nothing here is ever rendered on a public page.
--
-- Apply locally:  npx wrangler d1 execute shaws-carpentry --local  --file=db/migrations/004-documents.sql
-- Apply remotely: npx wrangler d1 execute shaws-carpentry --remote --file=db/migrations/004-documents.sql

CREATE TABLE IF NOT EXISTS documents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_type       TEXT NOT NULL DEFAULT 'quote'
                   CHECK (doc_type IN ('quote', 'order', 'invoice')),
  -- Which statuses are allowed depends on doc_type, which SQLite cannot
  -- express tidily. src/api.js holds the real rule.
  status         TEXT NOT NULL DEFAULT 'draft',
  ref            TEXT NOT NULL,

  -- Every number this job has held, so nothing is lost as it moves along.
  quote_ref      TEXT,
  order_ref      TEXT,
  invoice_ref    TEXT,

  issue_date     TEXT NOT NULL DEFAULT (date('now')),
  due_date       TEXT,                              -- invoices only

  title          TEXT NOT NULL DEFAULT '',
  customer_name  TEXT NOT NULL DEFAULT '',
  customer_phone TEXT NOT NULL DEFAULT '',
  customer_email TEXT NOT NULL DEFAULT '',
  job_address    TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',

  vat_rate       REAL NOT NULL DEFAULT 0,
  -- How much of the pricing the customer's copy shows: everything, task
  -- totals only, or nothing but the final figures.
  price_view     TEXT NOT NULL DEFAULT 'full'
                   CHECK (price_view IN ('full', 'summary', 'totals')),

  tasks          TEXT NOT NULL DEFAULT '[]',        -- JSON, see above
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_documents_listing ON documents (doc_type, issue_date, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_ref ON documents (ref);

-- Defaults, so the first quote is not built out of empty boxes. Business name,
-- address, VAT number and bank details are left for the admin to fill in:
-- a wrong guess would print on a customer's invoice.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('business_name', ''),
  ('business_address', ''),
  ('vat_number', ''),
  ('bank_account_name', ''),
  ('bank_sort_code', ''),
  ('bank_account_number', ''),
  ('payment_terms_days', '14'),
  ('quote_markup', '20'),
  ('quote_hourly_rate', '35'),
  ('quote_day_rate', '250'),
  ('quote_vat', '20');
