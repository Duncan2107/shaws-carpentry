# Shaws Carpentry

Website for a domestic and commercial carpentry business covering Sussex, Kent
and London. Live at **https://shawscarpentry.com**, served from a Cloudflare
Worker, with an admin area the owner uses to manage his own content.

Building a similar site for another client? See
[docs/new-client-site.md](docs/new-client-site.md).

## How it fits together

```
shawscarpentry.com
├── /                 four public pages, static HTML with content injected from D1
├── /img/<key>        photos uploaded through the admin, served from R2
├── /admin            content manager  ─┐ both behind Cloudflare Access
└── /api/*            admin API        ─┘
```

The four public pages are ordinary HTML in `public/`. The Worker runs ahead of
them and swaps the contents of containers marked `data-content` for whatever is
currently in the database, so pages still leave the edge as complete HTML (good
for search engines) and an edit is live immediately with no rebuild.

| Piece | Where |
|---|---|
| Public pages | `public/*.html` |
| Styling, design tokens | `public/css/styles.css` |
| Front-end behaviour | `public/js/main.js` |
| Admin area | `public/admin/` |
| Router, page rendering | `src/index.js` |
| Database reads → HTML | `src/content.js` |
| Admin API | `src/api.js` |
| Cloudflare Access checks | `src/auth.js` |
| Visitor statistics | `src/analytics.js` |
| Schema, seed, migrations | `db/` |

## Running it locally

```bash
npm install
```

```bash
npx wrangler dev --port 8137 --local
```

Then open http://localhost:8137. `wrangler dev` is the right way to run this —
a plain static file server will not exercise the Worker, the database or the
URL handling.

Local development needs a `.dev.vars` file (git-ignored, never deployed):

```
ADMIN_DEV_BYPASS=true
ANALYTICS_SALT=any-string-for-local-use
```

`ADMIN_DEV_BYPASS` opens `/admin` without a login, so the admin can be worked
on locally. Set it to anything other than `true` to exercise the real sign-in
screen. It only ever exists in `.dev.vars`; on the deployed Worker the sign-in
check is the only way in.

Seed a local database:

```bash
npx wrangler d1 execute shaws-carpentry --local --file=db/schema.sql
```

```bash
npx wrangler d1 execute shaws-carpentry --local --file=db/seed.sql
```

## The admin login

`/admin` and `/api` ask for a username and a password. The accounts live in
the `admin_users` table and hold a PBKDF2-SHA256 hash, never the password
itself. Create one, or change a password:

```bash
npm run set-password -- stuart --name "Stuart Shaw"
```

It asks for the password twice, then writes `db/admin-password.sql` with the
statement to apply:

```bash
npx wrangler d1 execute shaws-carpentry --remote --file=db/admin-password.sql
```

Delete that file afterwards. It is git-ignored, so it will not be committed.

Signing in sets a session cookie which the Worker signs and checks itself. It
lasts 24 hours. The signing key comes from the stored password hash, so
changing a password signs out every session that account had open. Ten wrong
guesses on one username locks it for 15 minutes.

The table is created by `db/migrations/003-admin-login.sql`, which has to be
applied before anyone can sign in.

> **If Cloudflare Access is still switched on for this domain it wins.** Access
> sits in front of the Worker, so it will show its own sign-in screen and will
> block `POST /api/login` before the password form is reached. Use one or the
> other: to use passwords, remove the Access application in Zero Trust. The
> Worker still accepts a valid Access token if `ACCESS_TEAM_DOMAIN` and
> `ACCESS_AUD` are set, so an existing setup keeps working.

## Deploying

```bash
npm run deploy
```

This publishes straight to the live site. There is no staging address: the
`workers.dev` URL is deliberately switched off so the site does not exist at a
second public address. Test locally first.

## Images

`public/Media/` holds web-sized images only: max 1600px wide, JPEG quality ~74.
Photos uploaded through the admin are shrunk in the browser before upload and
stored in R2, served from `/img/`.

The full-size originals live in `originals/`, which is **git-ignored and is the
only copy — back it up separately.** Committing 121MB of PNGs would make every
clone painful, which is why they are not in here.

## Content notes

- Services have two independent switches: `show_on_home` and
  `show_on_services`. The enquiry form's dropdown follows `show_on_services`
  only, so a service featured on the home page but with no page describing it
  is not offered as an enquiry option.
- A gallery entry is a *project* that can hold several photos. The first is the
  cover; opening it steps through the rest in a carousel.
- With no published reviews the home page shows a "Reviews coming soon" card
  and switches to the three-column grid as soon as one is published.
- House style: no em or en dashes in the copy, and no dash-like decorative
  flourishes.

## Enquiry form

Posts to Formspree (`https://formspree.io/f/xpqvkpjl`), set on the form's
`data-endpoint` in `contact.html` and overridden from the `form_endpoint`
setting in the database. Enquiries arrive at stuart@shawscarpentry.com. The
free tier covers 50 submissions a month.

## Visitor statistics

Recorded by the site itself into D1 and shown on the admin's Visitors tab.
No cookies and nothing identifying is stored, so the site needs no cookie
banner — see `db/migrations/002-page-views.sql` for exactly what is kept.

Obvious crawlers are filtered out, which includes `curl`: testing this from a
command line records nothing. Use a browser.
