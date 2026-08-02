# Project context

A small-business website with a content admin the owner runs themselves.
Built first for Shaws Carpentry; intended as the template for further client
sites.

Read this before changing anything. The companion documents are
[README.md](README.md) (how to run and deploy) and
[docs/new-client-site.md](docs/new-client-site.md) (standing up the next site,
including the domain-move order and the traps).

## The shape of it

```
theirdomain.com
├── /                public pages: static HTML with content injected from D1
├── /img/<key>       photos uploaded through the admin, stored in R2
├── /admin           the content manager   ─┐ both behind Cloudflare Access
└── /api/*           the admin's API       ─┘
```

Cloudflare Worker + D1 (database) + R2 (photo storage) + Access (login).
All on free tiers at this size.

The public pages are ordinary HTML files. The Worker runs ahead of them and
replaces the contents of any element carrying a `data-content` attribute with
whatever is currently in the database. Pages therefore leave the edge as
complete HTML — good for search engines — and an edit is live immediately with
no rebuild step.

```
public/            what a visitor sees
  *.html           the pages; containers marked data-content get filled
  css/styles.css   design tokens at the top, then components
  js/main.js       nav, scroll reveal, photo carousel, enquiry form
  admin/           the content manager (see "Core" below)
  Media/           web-sized images shipped with the site
src/
  index.js         routing, page rendering, /img/, www redirect, asset versioning
  content.js       database rows -> the HTML fragments each page expects
  api.js           admin API: validation, CRUD, uploads
  auth.js          Cloudflare Access token verification
  analytics.js     visitor statistics
db/
  schema.sql       tables
  seed.sql         generated, not hand-written
  extract-seed.py  reads a client's existing HTML and emits the seed
  migrations/      applied in order, numbered
originals/         full-size photos. Git-ignored, and the only copy.
```

## Core — keep these on every site

These are the parts worth having built once. Carry them across unchanged and
resist rewriting them per client.

### The admin section — all of it

`public/admin/` and `src/api.js`, `src/auth.js`. Six tabs: **Services,
Photos, Reviews, Quotes & invoices, Contact details, Visitors**. Keep every
one.

It is styled with the same design tokens as the public site, so it reads as
part of the client's business rather than a generic control panel. Rebranding
it is a matter of the CSS variables, not new markup.

Sign-in has two supported forms, both checked in `src/auth.js`, and both
checked **inside the Worker**. That last part is the rule that does not bend:
the Worker can be reachable on hostnames a policy in front of it does not
cover, so anything that trusts a header it has not verified is bypassable.

| Form | How it works |
|---|---|
| **Username and password** (default) | An account in `admin_users`, holding a PBKDF2-SHA256 hash and never a password. Signing in sets a session cookie that the Worker signs and verifies itself. |
| **Cloudflare Access** | Used instead if `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set and a valid token arrives. The Worker verifies the token's signature, audience and issuer against the team's public keys. |

Accounts are created with `db/set-admin-password.js`, which prints the SQL to
run and never writes a password anywhere. The session cookie is signed with a
key derived from the stored hash, so changing a password signs out every
session that account had open.

**Access and the password login cannot both guard the same paths.** An Access
application sits in front of the Worker, so while one covers `/admin` it will
intercept the request before the password form is ever reached, and it will
block `POST /api/login` too. Pick one. If you choose passwords, remove the
Access application in Zero Trust.

`ADMIN_DEV_BYPASS` in `.dev.vars` opens the admin locally. That file is
git-ignored and never uploaded, so it cannot leak into a deployment. Set it to
anything other than `true` to exercise the real sign-in locally.

### The enquiry form

Lives on the contact page, posts via `fetch` in `js/main.js`, and shows
"Thanks for your enquiry, we will be in touch soon." without leaving the page.
Validation is inline, errors sit under their field, and a network failure falls
back to showing the direct email address.

**The destination must be configurable per site.** Two settings control it:

| Setting | What it does |
|---|---|
| `form_endpoint` | Where the form posts. A Formspree form URL, one per client |
| `email` | The address shown on the page, and the fallback if sending fails |

Both live in the `settings` table and are injected by the Worker, so neither is
hardcoded in the HTML. Never commit a client's endpoint into `contact.html` as
the only copy.

*Known gap:* `form_endpoint` is accepted by the API but is not yet a field on
the admin's Contact details form, so today it can only be changed in the
database. Worth adding before the next site.

### Services, and their two switches

Each service has two independent flags. This is deliberate and should not be
collapsed back into one:

| Flag | Effect |
|---|---|
| `show_on_services` | On the services page **and** in the enquiry form's dropdown |
| `show_on_home` | In the home page grid |

Either, both, or neither. Off for both means it is not on the site anywhere.

The dropdown deliberately follows `show_on_services` alone: a service featured
on the home page but with no page describing it would be a dead end if someone
enquired about it.

Services are grouped by `category`. Here that was domestic/commercial; for
another trade it might be something else, but keep the grouping — it is what
lets one business serve two quite different audiences from one site.

The "Something else in mind?" card is page furniture rendered in
`src/content.js`, not a database row, so a client cannot delete it by accident
and leave the section looking bare.

### The photos section

A gallery entry is a **project**, not a photo. It has a caption and holds one
or more images (`gallery` and `gallery_images`). The first image is the cover
shown in the grid; opening it steps through the rest with arrows, arrow keys
and swipe. A project with several photos gets an "N photos" badge.

The admin's photo editor manages the whole set: add, remove, reorder, and mark
which is the cover. It opens with no rows and the message "No photos yet",
because pre-selecting a photo meant projects were published with an image
nobody chose.

**Uploads are shrunk in the browser** to 1600px JPEG before being sent. Client
photos come off phones at 5–10MB; resizing first makes uploading quick on a
site signal and means what lands in R2 is already the right size.

The server identifies uploads by their **own bytes**, not the `Content-Type`
the client claims, because these files are served back to the public. They are
named by content hash, and `/img/` only accepts that shape.

### Quotes and invoices

`public/admin/documents.js`, the `documents` collection in `src/api.js`, and
`db/migrations/004-documents.sql`. This replaced a standalone quoting app the
client was running as a Windows executable, with its data in a JSON file on one
machine.

A job is **one row that moves along**: quoted, then an invoice when the work is
done. It keeps the reference it held as a quote (`quote_ref`), so an invoice
still shows where it came from. Accepted work waiting to be done is a quote
marked Accepted, not a third kind of document: an orders stage existed briefly
and was removed as needless. `order_ref` is still in the table, unused, because
dropping a D1 column costs more than leaving it.

Each type has its own statuses. "Overdue" is not stored, it is worked out from
the due date, so it can never go stale.

| Rule | Why |
|---|---|
| The **client sets the reference**, the admin only suggests the next one | They may already number jobs their own way. It is required and unique, and the database enforces the uniqueness. |
| The task and material breakdown is a **JSON column** | It is only ever read and written whole by one screen. Two more tables would buy nothing. |
| Cost price and profit **never** reach the printed copy | They are on screen for the client alone. This is the one thing that must not regress. |
| The customer's copy has **three levels of detail** | Full breakdown, task totals only, or one price with the work listed but no figures against it. A bare total with nothing described is not a quotation, so the work is still named. |
| A material can be **priced by hand** instead of cost plus markup | Sometimes you know what you are charging without knowing what it costs you. A price typed in wins, and the markup box switches off so it does not look as though it still applies. |
| Every question and warning is **one centred dialog** | `window.confirm` and `window.prompt` are gone. Note that the site's reset zeroes the margin a browser uses to centre a modal `<dialog>`, so `.admin-dialog` sets `margin: auto` itself. |
| The "already gone out" warning judges the **saved** status, not the one in the box | Otherwise marking a draft invoice as Sent warns you about editing a sent invoice, which is nonsense. |
| Business details, VAT number and bank details come from the **Contact details tab** | Entered once, so a quote can never disagree with the website. The VAT number and bank details print on invoices only. |
| The printed copy **waits for the logo to load** before printing | `window.print()` fired straight after setting the markup prints without it. |
| `@page { margin: 14mm }`, not padding on the container | Padding puts space at the top of the first page and the bottom of the last, and nothing in between, so a second page starts hard against the paper edge. Only a page margin applies to every sheet. `margin: 0` was tried, because it also suppresses the browser's own URL and date, and it broke multi-page documents. Unticking "Headers and footers" in the print dialog is the answer to those instead. |
| Each task is a `section.task` with `break-inside: avoid` | Otherwise a page break lands in the middle of a task and splits its figures from its heading. |

Nothing here is rendered on a public page, and nothing should be: these rows
hold customer names, addresses, phone numbers and bank details. `src/content.js`
names the settings keys it uses, which is what keeps the bank details off the
site.

The arithmetic in `documents.js` is carried over unchanged from the app it
replaced. It had been in use and giving the right answers. If it needs
changing, change it in one place: the printed copy and the screen must never
disagree.

### Also worth keeping

- **Visitor statistics** (`src/analytics.js`) — cookieless, so no cookie
  banner. Nothing identifying is stored; see
  `db/migrations/002-page-views.sql`. Each visitor is credited to one source:
  where they first arrived that day.
- **Empty states everywhere.** A hidden section renders a short message, never
  a blank space with a heading above it.
- **Asset versioning.** The Worker stamps `/css/` and `/js/` URLs with the
  deployment id, so a browser cannot run yesterday's JavaScript against
  today's markup.

## Per-site — expect to change these every time

| What | Where |
|---|---|
| Brand colours, fonts, spacing | tokens at the top of `public/css/styles.css` |
| Page copy and layout | `public/*.html` |
| The HTML each database row renders as | template functions in `src/content.js` |
| Content | `db/seed.sql`, generated by `db/extract-seed.py` |
| Worker name, database id, bucket, routes | `wrangler.toml` |
| Access team domain and audience tag | `[vars]` in `wrangler.toml` |
| `ANALYTICS_SALT` | a per-site secret, `wrangler secret put` |
| Contact details, areas, hours, form endpoint | `settings` table, edited in the admin |

`src/content.js` is the interesting one: the **queries** are generic, the
**HTML fragments** are specific to this design. A client with a different card
layout means rewriting those functions and nothing else.

## Conventions

- **No em or en dashes in copy**, and no dash-like decorative flourishes. Use
  commas, colons or full stops; "to" in ranges ("8am to 6pm").
- Write for the client's customer, not the developer. "Show on the home page",
  not "featured flag".
- Mark every container the Worker fills with `data-content="..."`. Positional
  selectors were tried and break the moment the layout changes.
- Migrations are numbered and additive. Do not edit `schema.sql` in place and
  re-run it against a live database — it drops tables.
- `db/seed.sql` is generated. Change the extractor, not the output.

## Things that will bite

- **`wrangler deploy` cannot attach a custom domain over an existing DNS
  record** — the API returns 409. Delete the old record first, or use the
  dashboard, which swaps it atomically.
- **Declaring `[[routes]]` switches off the `workers.dev` address**, removing
  your test URL mid-migration. Set `workers_dev = true` until the custom domain
  is live, then turn it off so the site is not public at two addresses.
- **The bot filter excludes `curl`.** Testing analytics from a command line
  records nothing. Use a browser.
- **`await` anything async returned from inside a `try`** — returning the
  promise unawaited lets a rejection escape the catch and surface as a raw
  stack trace.
- **DNS caches outlive the change.** Verify with `curl --resolve` against the
  Cloudflare address rather than trusting the local network.
