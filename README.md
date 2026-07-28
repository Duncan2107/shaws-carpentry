# Shaws Carpentry

Marketing site for Shaws Carpentry — domestic and commercial carpentry across Sussex, Kent and London.

## Layout

```
public/           Everything that gets deployed
  index.html      Home
  services.html   Domestic and commercial services
  gallery.html    Our Work (photo grid + lightbox)
  contact.html    Contact details and enquiry form
  css/styles.css  All styling (design tokens at the top)
  js/main.js      Nav, scroll reveal, lightbox, contact form
  Media/          Web-sized images (~1600px JPEG)
originals/        Full-size source photos — NOT in git, NOT deployed
```

## Running locally

```bash
python -m http.server 8137 --directory public
```

Then open http://localhost:8137.

## Images

`public/Media/` holds web-sized images only: max 1600px wide, JPEG quality 74,
roughly 100–360 KB each. The originals are 5–9.5 MB PNGs and live in
`originals/`, which is git-ignored.

**Back `originals/` up somewhere else.** It is the only high-resolution copy and
it is not in this repository by design — committing 121 MB of PNGs would make
every clone painful.

To regenerate a web image after adding a new original, resize to 1600px wide and
save as JPEG at quality ~74.

## Contact form

Posts to Formspree (`https://formspree.io/f/xpqvkpjl`) via `fetch` in
`js/main.js`; the endpoint is set on the form's `data-endpoint` attribute in
`contact.html`. Enquiries arrive at stuart@shawscarpentry.com. Free tier allows
50 submissions/month.

## Content notes

- Services are split Domestic (14) and Commercial (2: Fire Doors, Metal
  Partitioning). The contact form's dropdown mirrors this split.
- The reviews section on the home page currently shows a single "Reviews coming
  soon" card. When real reviews arrive, swap it for `.quote` figures inside a
  plain `.quote-grid` — that styling already exists in `css/styles.css`.
- House style: no em or en dashes in copy, and no dash-like decorative
  flourishes.
