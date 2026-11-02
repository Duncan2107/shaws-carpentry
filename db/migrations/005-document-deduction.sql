-- An overall deduction on a quote or invoice, taken off the subtotal before
-- VAT is worked out.
--
--   deduction        how much: pounds, or a percentage of the subtotal
--   deduction_type   which of those 'deduction' is
--   deduction_label  the words printed against it, e.g. "Loyalty discount".
--                    Empty prints "Less deduction".
--
-- And the Construction Industry Scheme, for work done for a contractor:
--
--   cis              1 when the job comes under CIS
--   cis_rate         the deduction the contractor makes from the labour:
--                    20 registered, 30 not registered, 0 gross payment status
--   reverse_charge   1 when the VAT domestic reverse charge applies, so VAT
--                    is shown but not charged and the customer pays it to HMRC
--
-- plus a 'utr' setting, the Unique Taxpayer Reference printed on CIS jobs.
--
-- Additive only. Every existing job gets 0, which takes nothing off, and is
-- not a CIS job, so no total that has already been quoted or invoiced changes.
--
-- Apply this before deploying the code that uses it. The admin writes these
-- columns on every save, so a Worker deployed ahead of it cannot save a job.
--
-- Apply locally:  npx wrangler d1 execute shaws-carpentry --local  --file=db/migrations/005-document-deduction.sql
-- Apply remotely: npx wrangler d1 execute shaws-carpentry --remote --file=db/migrations/005-document-deduction.sql

ALTER TABLE documents ADD COLUMN deduction REAL NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN deduction_type TEXT NOT NULL DEFAULT 'amount'
  CHECK (deduction_type IN ('amount', 'percent'));
ALTER TABLE documents ADD COLUMN deduction_label TEXT NOT NULL DEFAULT '';

ALTER TABLE documents ADD COLUMN cis INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN cis_rate REAL NOT NULL DEFAULT 20
  CHECK (cis_rate IN (0, 20, 30));
ALTER TABLE documents ADD COLUMN reverse_charge INTEGER NOT NULL DEFAULT 0;

-- Left empty for the admin to fill in: a wrong guess would print on an invoice.
INSERT OR IGNORE INTO settings (key, value) VALUES ('utr', '');
