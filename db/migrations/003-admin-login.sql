-- Username and password sign-in for /admin, as an alternative to Cloudflare
-- Access.
--
-- No password is stored. What is stored is a PBKDF2-SHA256 derivation of it
-- with a random per-user salt, in the form
--   pbkdf2$sha256$<iterations>$<salt>$<hash>
-- with salt and hash in base64url. The iteration count travels with the hash,
-- so it can be raised later without invalidating existing accounts.
--
-- Create or change an account with db/set-admin-password.js, which prints the
-- statement to run. Never write a password into this file or into seed.sql.
--
-- Apply locally:  npx wrangler d1 execute shaws-carpentry --local  --file=db/migrations/003-admin-login.sql
-- Apply remotely: npx wrangler d1 execute shaws-carpentry --remote --file=db/migrations/003-admin-login.sql

CREATE TABLE IF NOT EXISTS admin_users (
  username      TEXT PRIMARY KEY,                  -- compared in lower case
  password_hash TEXT NOT NULL,                     -- see the format above
  display_name  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

-- Failed sign-in attempts, kept only long enough to slow down guessing. A
-- successful sign-in clears the rows for that username, and anything older
-- than the lockout window is pruned as it goes.
CREATE TABLE IF NOT EXISTS admin_login_attempts (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admin_login_attempts ON admin_login_attempts (username, at);
