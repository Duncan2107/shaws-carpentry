# Client site: build and deployment playbook

A complete run-through for standing up a small-business website with a
self-service admin area, based on the one built for Shaws Carpentry.

Written to be followed start to finish. Roughly half a day for the build, plus
a short wait for DNS if an existing domain is being moved.

---

## 1. What this system is

A marketing site the client can maintain themselves, without touching code or
coming back to you for every change.

**For the client's customers:** a fast, mobile-friendly site with services,
a photo gallery, and an enquiry form.

**For the client:** a private `/admin` area where they add and remove services,
upload photos, publish customer reviews, change their contact details, and see
how many people visited and where those people came from.

**For you:** every client site sits in one Cloudflare account with deploy
history and analytics in one dashboard, and the whole stack is free at this
size.

### What it is made of

| Piece | Doing what |
|---|---|
| Cloudflare Worker | serves the site, injects content, hosts the admin API |
| D1 | the database: services, photos, reviews, settings, visit statistics |
| R2 | photo storage for anything uploaded through the admin |
| Cloudflare Access | the login on `/admin`, no passwords to store |
| Formspree | delivers enquiry form submissions to the client's inbox |

### How the pages work

The public pages are ordinary HTML files. The Worker runs ahead of them and
swaps the contents of any element marked `data-content` for whatever is in the
database. So:

- pages leave the edge as complete HTML, which search engines can read
- a change made in the admin is live immediately, with no rebuild
- if the database is ever unreachable, the plain page is served rather than an
  error

### What was achieved on the reference build

- Photos cut from **121MB to 3.2MB** (a gallery page that previously tried to
  load ~110MB)
- Hosting moved from Netlify to Cloudflare with **no downtime and no
  interruption to the client's email**
- Content moved out of hardcoded HTML into a database the client controls
- Admin area, photo uploads, a photo carousel, and cookieless visitor
  statistics

---

## 2. Before you start

**Accounts:** Cloudflare, GitHub, Formspree (free tier: 50 enquiries/month).

**Installed:** Node.js, Python 3, Git.

**From the client:** logo, brand colours, photos, service list, contact
details, opening hours, areas covered, and the email address enquiries should
reach.

**One-off on the Cloudflare account:** enable R2. Dashboard → R2 Object
Storage → Enable. It may ask for a card to verify the account; the free tier
covers 10GB.

---

## 3. Prepare the content

### Photos

Client photos routinely arrive at 5–10MB each. Serving those directly makes a
site unusable on mobile data, so resize before anything else.

Target: **max 1600px on the long edge, JPEG quality ~74**, which lands around
100–350KB with no visible loss.

- Put web-sized images in `public/Media/`, named in lowercase with hyphens.
- Keep the originals in `originals/`, which is git-ignored. **Tell the client
  this is the only copy and they should back it up.**

### Copy

Write it as the client's customer would read it. Then check it against the
house style: no em or en dashes, no decorative dash flourishes.

---

## 4. Set up the project

Copy the template. Keep `src/`, `public/admin/`, `db/schema.sql`,
`package.json`, `wrangler.toml`. Replace the public pages, the brand tokens at
the top of `public/css/styles.css`, and the content.

```bash
npm install
```

```bash
npx wrangler login
```

Mark every container the Worker will fill with a `data-content` attribute, for
example `data-content="services-domestic"`. Do not rely on position or nth-child
selectors — they break as soon as the layout changes.

Then create a `.dev.vars` file. It is git-ignored and never uploaded:

```
ADMIN_DEV_BYPASS=true
ANALYTICS_SALT=any-string-for-local-use
```

`ADMIN_DEV_BYPASS` opens `/admin` locally so you can build it before the real
login exists. Because it only ever lives in `.dev.vars`, it cannot reach a
deployment.

---

## 5. Create the Cloudflare resources

```bash
npx wrangler d1 create <site-name>
```

Copy the `database_id` it prints into `wrangler.toml`.

```bash
npx wrangler r2 bucket create <site-name>-photos
```

If this fails with "Please enable R2", do the one-off dashboard step in
section 2 first.

Generate a per-site secret for the visitor statistics:

```bash
python -c "import secrets; print(secrets.token_hex(32))" | npx wrangler secret put ANALYTICS_SALT
```

Update `wrangler.toml`: the Worker `name`, the D1 `database_name` and
`database_id`, the R2 `bucket_name`. Leave the Access variables and routes for
now, and set `workers_dev = true` so you have somewhere to test.

---

## 6. Load the content

Apply the schema:

```bash
npx wrangler d1 execute <site-name> --remote --file=db/schema.sql
```

If the client already has a website, **write a small extractor rather than
retyping their content**. `db/extract-seed.py` reads the existing HTML and
emits the INSERT statements, so nothing is lost or subtly reworded. Then:

```bash
npx wrangler d1 execute <site-name> --remote --file=db/seed.sql
```

Do the same with `--local` for a local database to develop against.

---

## 7. Build and test locally

```bash
npx wrangler dev --port 8137 --local
```

Use this rather than a plain static file server: it is the same runtime as
production, including the URL handling and the database.

Check before going further:

- all pages load, and the navigation works
- the photo carousel opens and steps through
- the enquiry form validates and submits
- `/admin` opens (via the dev bypass) and each tab loads
- hiding everything in a section shows a message, not a blank space

---

## 8. First deploy

```bash
npm run deploy
```

This publishes to a `*.workers.dev` address. The client's existing site, if
they have one, is untouched — nothing points at Cloudflare yet.

Test everything again on that URL before continuing.

---

## 9. Move the domain

**Skip to section 10 if the domain is new.**

The order matters. Getting it wrong takes the client's email down, and nobody
notices for a day.

### 9a. Write down what the domain currently does

Before touching anything, record the live records — especially the mail ones:

```bash
for t in NS A MX TXT; do curl -s "https://dns.google/resolve?name=CLIENTDOMAIN.com&type=$t"; done
```

Also check `google._domainkey.CLIENTDOMAIN.com` and `_dmarc.CLIENTDOMAIN.com`.
Save the results somewhere in the repo. **The website is the obvious thing; the
mailbox is the thing that quietly breaks.**

### 9b. Add the domain to Cloudflare

Dashboard → Add a domain → Free plan. Cloudflare scans the existing DNS and
imports what it finds. **This changes nothing on its own.**

### 9c. Check the import

Compare against what you recorded. Confirm MX, SPF and DKIM are all present.
The scan is good, not perfect.

### 9d. Grey-cloud the website records

Set the **A** record and the **www CNAME** to **DNS only** (grey cloud), still
pointing at the old host.

This matters: proxied, Cloudflare sits in front of the old host, and a new
zone's default SSL mode fights with hosts that force HTTPS. The classic result
is a redirect loop minutes after the switch, which looks like the migration
broke everything.

### 9e. Change the nameservers

At the registrar, replace the existing nameservers with the two Cloudflare
gives you. Cloudflare only provides two; that is correct.

Because of step 9d this is invisible to visitors — traffic still reaches the
old host exactly as before. Verify:

```bash
curl -sI https://CLIENTDOMAIN.com | head -3
```

and confirm the MX record still resolves.

### 9f. Point the domain at the Worker

**This is the moment visitors move across.**

Delete the old **A** record, then in the dashboard: Workers & Pages → your
Worker → Settings → Domains & Routes → **Add → Custom Domain**. Repeat for
`www`.

Do `www` first as a rehearsal. The main domain is then only unreachable for
the few seconds between deleting its record and attaching it, and by that point
you have done the procedure once.

> `wrangler deploy` **cannot** do this over an existing record — the API
> returns 409 rather than overwriting a live record from a script. Use the
> dashboard, which swaps it atomically.

### 9g. Verify

Local DNS will lie to you here. Force the connection instead:

```bash
curl -sI --resolve CLIENTDOMAIN.com:443:CLOUDFLARE_IP https://CLIENTDOMAIN.com
```

Look for `Server: cloudflare` and a `CF-RAY` header. Then check the site, the
enquiry form, and the mail records once more.

**Leave the old host running for a few days.** Stale DNS caches are still
sending real visitors there; deleting it immediately turns a stale cache into a
hard failure.

---

## 10. Turn on the login

Two options. **Pick one, not both:** an Access application sits in front of
the Worker, so while one covers `/admin` it intercepts every request before
the Worker's own check runs, and it blocks `POST /api/login` as well.

### 10a. A username and password (simpler)

Nothing to configure in the dashboard. Apply the migration, then create the
client's account:

```bash
npx wrangler d1 execute <site-name> --remote --file=db/migrations/003-admin-login.sql
```

```bash
npm run set-password -- <username> --name "Their Name"
```

That prints the statement to apply, and never writes the password anywhere:

```bash
npx wrangler d1 execute <site-name> --remote --file=db/admin-password.sql
```

Delete `db/admin-password.sql` afterwards. Give the client the password by
something better than email, and tell them a new one can be set any time by
running the same command again.

> On the **free** Cloudflare plan a Worker gets about 10ms of CPU per request,
> and the default of 100,000 PBKDF2 iterations may exceed it. If signing in
> fails with a CPU limit error, set the account up again with
> `--iterations 10000` and deploy nothing: the count travels with the stored
> hash.

Then confirm:

- `/admin` signed out shows the sign-in form
- `/api/content` signed out returns 403
- the right password gets in, and Sign out returns you to the form
- all public pages still return 200

### 10b. Cloudflare Access instead

Zero Trust → Access → Applications → **Add an application → Self-hosted**,
then the **Public DNS** option.

- Name it, session duration 24 hours
- Add **two** destinations on the client's domain: path `admin`, and path `api`
- Policy: Action **Allow**, Include → **Emails** → the client's address and
  your own

**Never add the bare domain with no path** — that puts the whole public site
behind the login.

Then collect two values:

- the **Zero Trust team name**, from the dashboard URL
  (`https://<team>.cloudflareaccess.com`)
- the **Application Audience (AUD) tag**, on the application's overview

> The AUD is **64 hex characters with no dashes**. The policy ID is a UUID
> *with* dashes. They are easy to confuse and only one works.

Put both into `[vars]` in `wrangler.toml`:

```toml
[vars]
ACCESS_TEAM_DOMAIN = "<team>.cloudflareaccess.com"
ACCESS_AUD = "<64-hex-characters>"
```

Neither is secret — the team domain publishes its signing keys openly and the
audience tag only names the application. The security comes from the Worker
verifying the token's signature against those keys.

Deploy, then confirm:

- `/admin` signed out redirects to a login
- `/api/content` signed out returns 403
- a forged `Cf-Access-Jwt-Assertion` header is rejected
- all public pages still return 200

---

## 11. Close it out

**Switch off the test address** so the site is not public at two URLs, which
Google may treat as duplicate content:

```toml
workers_dev = false
preview_urls = false
```

Then deploy. From this point there is no staging URL — test locally.

**Point the enquiry form at the client.** Create their Formspree form and set
`form_endpoint` in the `settings` table. Send a real test enquiry and confirm it
arrives.

**Add a DMARC record** so nobody can forge email from their domain — which
matters for a business that quotes and invoices by email:

| Field | Value |
|---|---|
| Type | `TXT` |
| Name | `_dmarc` |
| Content | `v=DMARC1; p=reject; rua=mailto:THEIR@EMAIL.com` |

Use `p=reject` only if all their mail goes through one provider whose SPF and
DKIM already pass. If they send from invoicing tools or mailing lists too,
start at `p=none`, watch for a fortnight, then tighten.

Paste that Content value on **one line only** — pasting a table row can drag
stray text in, and a malformed record is silently ignored, giving no protection
while looking configured.

**Delete the old host** once caches have expired.

---

## 12. Hand over

Show the client:

- their admin URL, and how they sign in: a username and password they can
  save in their browser, or an emailed code if you set up Access instead
- how to add a service and tick which pages it appears on
- how to add a photo project, and that several photos become a carousel
- how to publish a review, and that the "Reviews coming soon" message
  disappears by itself once they do
- the Visitors tab

Tell them: **changes are live immediately**, and there is no separate publish
step.

---

## Launch checklist

- [ ] Images under ~350KB each; originals kept outside the repo and backed up
- [ ] All pages, navigation, carousel and enquiry form tested
- [ ] Enquiry form delivers to the client's inbox (send a real one)
- [ ] `/admin` requires a login; `/api` refuses signed-out requests
- [ ] Client's email still working after any DNS change
- [ ] `workers.dev` disabled
- [ ] DMARC record present and valid
- [ ] Old host still running as a rollback, deleted after a few days
- [ ] Client shown how to use the admin

---

## Traps worth knowing

**`wrangler deploy` cannot attach a custom domain over an existing DNS
record.** 409. Delete it first or use the dashboard.

**Declaring `[[routes]]` switches off `workers.dev` by default**, removing
your test URL mid-migration. Keep `workers_dev = true` until the custom domain
is live.

**DNS caches outlive the change.** One reference case cached the old host for
four hours; mobile data was no better, because carrier resolvers cache too.
Setting the machine's DNS to `1.1.1.1` was the only fix. Verify with
`curl --resolve`, and warn the client so they do not think the site is broken.

**The analytics bot filter excludes `curl`.** Testing from a command line
records nothing. Use a browser.

**Browsers cache CSS and JavaScript.** The Worker stamps those URLs with the
deployment id for this reason. Remove it and a returning visitor will run old
JavaScript against new markup, which looks like a broken feature rather than a
caching problem.

**`await` anything async returned from inside a `try`.** Returning the promise
unawaited lets a rejection escape the catch and surface as a raw stack trace
with file paths.
