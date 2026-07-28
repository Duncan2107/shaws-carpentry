# Moving shawscarpentry.com to Cloudflare

Captured 2026-07-28, before any changes. Keep this file: if anything goes
wrong mid-migration, everything needed to put the domain back is here.

## How it was set up beforehand

| Thing | Where it lived |
|---|---|
| Domain registrar | Squarespace |
| DNS host | Squarespace (`nsd1`–`nsd4.squarespacedns.com`) |
| Website | Netlify |
| Email | Google Workspace |

## The records as they were

```
NS      @                    nsd1.squarespacedns.com
                             nsd2.squarespacedns.com
                             nsd3.squarespacedns.com
                             nsd4.squarespacedns.com

A       @                    75.2.60.5                     (Netlify)
CNAME   www                  <site>.netlify.app            (Netlify)

MX      @              1     smtp.google.com               (Google Workspace)
TXT     @                    v=spf1 include:_spf.google.com ~all
TXT     google._domainkey    v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArxxPusfetW4ZGOTB6DoB9k7neH/pUNMFKMmzRzW8AOkaPCWDdkPifqtQnXTRwC6FIgIQooRCXpi9l05IvcCA6f7fzKLt+bpnjj3OtyS+OJ1sZ1GPGPaYsOUdTjqbQiGsDMOOTPfMu5wcDnRojLrLDemXr0d41/U4WRKxei98XjxDD2kKyoFipAHW3ZawENzRRs4oQWG297Z24U8kIU9V4EAEpKsS1DFvpxZuTWC4kx7F3fPYzOFWkbKMdgR67v5aZc+kdxIyzRBklfnKiI3YLtBii7uLXk0fJ7MyJzMjJ7BP+KbG8mVgniTtAiSSLDHfqy5d+DblM4puUTi2+Y2aAQIDAQAB

(no DMARC record existed)
```

## The one that matters most

**The MX, SPF and DKIM records are Stuart's email.** `stuart@shawscarpentry.com`
is a live Google Workspace mailbox and it is where every website enquiry
lands. Moving nameservers to Cloudflare makes Cloudflare the DNS host for the
whole domain, so if those three records are missing when the switch happens,
email stops arriving. Nothing bounces back to say so.

So the order below never changes: **get the records into Cloudflare and check
them, then switch the nameservers.** Never the other way round.

## Order of work

1. Add `shawscarpentry.com` to Cloudflare (Free plan). Cloudflare scans the
   existing DNS and imports what it finds.
2. **Check the import against the table above**, especially MX, SPF and DKIM.
   Add anything missing by hand.
3. Point the Worker at the domain: `shawscarpentry.com` and `www`.
4. Only now, change the nameservers at Squarespace to the two Cloudflare gives
   you.
5. Wait for propagation, then check: the site loads, and a test email to
   `stuart@shawscarpentry.com` arrives.
6. Put the login on `/admin` and `/api` (see below).
7. Leave the Netlify site running for a few days as a rollback, then delete it.

## Rolling back

Set the nameservers at Squarespace back to `nsd1`–`nsd4.squarespacedns.com`.
The old records are still there, so the site returns to Netlify and email is
unaffected. Propagation takes up to a few hours.

## Access (the admin login)

Once the domain is on Cloudflare, the login can be scoped to paths, which is
the whole reason for doing the move in this order:

- `shawscarpentry.com/admin` and `/api` require sign-in
- every other page stays public

Zero Trust → Access → Applications → Add → Self-hosted, with two
destinations on `shawscarpentry.com`: path `admin` and path `api`. Then set
the Worker's `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` and redeploy.
