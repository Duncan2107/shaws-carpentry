# Building the next client site

This project is meant to be reused. Roughly: the `src/` code and the admin area
are generic, and everything a visitor sees is not.

Read the last section before doing a domain move. It is the part that cost the
most time on this one.

## What carries over, and what does not

| Reuse as-is | Rewrite per client |
|---|---|
| `src/auth.js` — Cloudflare Access checks | `public/*.html` — the pages themselves |
| `src/analytics.js` — visitor statistics | `public/css/styles.css` — brand tokens at the top |
| `src/api.js` — CRUD, validation, uploads | `src/content.js` — the HTML each database row renders as |
| `src/index.js` — routing, injection, `/img/` | `db/seed.sql` — their content |
| `public/admin/*` — the whole admin | `wrangler.toml` — names, ids, domains |
| `db/schema.sql` — unless the content model differs | |

`src/content.js` is the interesting one. The *queries* are generic; the HTML
fragments are specific to this design. A new site with a different card layout
means rewriting those template functions and nothing else.

## Steps

**1. Copy the project, drop the client-specific parts**

Keep `src/`, `public/admin/`, `db/schema.sql`, `package.json`. Replace the
public pages, the stylesheet's brand tokens, and the seed.

**2. Rename in `wrangler.toml`**

`name`, the D1 `database_name` and `database_id`, the R2 `bucket_name`, the
Access variables, and the routes.

**3. Create the resources**

```bash
npx wrangler d1 create <site-name>
```

```bash
npx wrangler r2 bucket create <site-name>-photos
```

R2 needs enabling once per account in the dashboard before the second command
works.

**4. Mark the injection points**

Give each container the Worker fills a `data-content` attribute — for example
`data-content="services-domestic"`. Positional selectors were tried first and
are worse: they break the moment the layout changes.

**5. Schema, seed, secret**

```bash
npx wrangler d1 execute <site-name> --remote --file=db/schema.sql
```

```bash
python -c "import secrets; print(secrets.token_hex(32))" | npx wrangler secret put ANALYTICS_SALT
```

If the client already has a hand-built site, write a small extractor like
`db/extract-seed.py` rather than retyping their content. It reads the existing
HTML and emits the INSERTs, so nothing is lost or subtly reworded.

**6. Access**

Zero Trust → Access → Applications → Self-hosted, with destinations on
`theirdomain.com` paths `admin` and `api`. Never add the bare domain with no
path — that puts the public site behind the login.

Copy the team domain and the Application Audience (AUD) tag into
`[vars]` and deploy. **The AUD is 64 hex characters with no dashes; the policy
ID is a UUID with dashes.** They are easy to confuse and only one of them works.

**7. Photos**

Compress before launch. Phone and stock photos are routinely 5–10MB, and a
gallery of them makes a site unusable on mobile data. 1600px wide at JPEG
quality ~74 gives roughly 100–350KB with no visible loss. Keep originals
outside the repo.

## Moving a live domain to Cloudflare

The order matters, and getting it wrong takes the client's email down.

**Check what the domain does before touching it.** Query the live records
first — MX, SPF, DKIM, DMARC — and write them down, as
[dns-migration.md](dns-migration.md) does for this site. The website is the
obvious thing; the mailbox is the thing that quietly breaks and nobody notices
for a day.

**Then, in this order:**

1. Add the domain to Cloudflare. This changes nothing on its own.
2. Check the imported records against what you wrote down. The scan is good,
   not perfect.
3. **Set the website's A and CNAME records to DNS only (grey cloud).** Leave
   them pointing at the old host.
4. Change the nameservers at the registrar. Because of step 3 this is invisible
   to visitors: traffic still reaches the old host exactly as before.
5. Confirm the site still loads and email still resolves.
6. Only now point the domain at the Worker.

Splitting it this way means a nameserver change and a hosting change are two
separate, individually reversible steps rather than one large one.

### Traps worth knowing

**`wrangler deploy` cannot attach a custom domain over an existing DNS record.**
The API returns 409 rather than overwriting a live record from a script with
nobody there to confirm. Delete the old record in the dashboard first, or use
the dashboard's Add Custom Domain, which swaps it atomically. Do `www` first as
a rehearsal, then the apex — the main domain is only unreachable for the few
seconds between deleting and attaching, and by then you have done it once.

**Declaring `[[routes]]` switches off the `workers.dev` address by default.**
That is usually what you want at the end, but it will remove your test URL
mid-migration. Set `workers_dev = true` explicitly until you are finished, then
turn it off so the site does not exist at two public addresses.

**Old DNS answers stick around far longer than you expect.** This domain had a
4-hour TTL, so the developer's own machine kept reaching the old host long after
the switch was complete and correct. Mobile data was no better — carrier
resolvers cache too. Setting the machine's DNS to `1.1.1.1` was the only thing
that helped. Verify with `curl --resolve` against the Cloudflare address rather
than trusting whatever the local network says, and warn the client so they do
not think the site is broken.

**Leave the old host running for a few days.** While stale caches persist it is
still serving real visitors. Deleting it immediately turns a stale cache into a
hard failure.

## Other things learned here

**Version the CSS and JS URLs.** The Worker appends the deployment id to
`/css/` and `/js/` URLs. Without it a browser will happily run yesterday's
JavaScript against today's markup — which happened here, and looked like a
broken feature rather than a caching problem.

**`await` anything async you return from inside a `try`.** Returning the
promise unawaited lets a rejection escape the `catch` and surface as a raw
stack trace with file paths.

**Identify uploads by their bytes, not the `Content-Type` the client sends.**
These files get served back to the public. Name them by content hash and let
the serving route accept only that shape.

**The bot filter catches `curl`.** Correct behaviour, but it means testing
analytics from the command line records nothing. Use a browser.
