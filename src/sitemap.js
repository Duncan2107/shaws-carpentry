/**
 * robots.txt and sitemap.xml.
 *
 * Both are generated here rather than written as files in public/, for two
 * reasons. The sitemap's dates come from the database, so it keeps telling the
 * truth as Stuart edits the site and nobody has to remember to update it. And
 * neither file names the domain, they take it from the request, so the next
 * client site inherits both of them working with nothing to change.
 *
 * Cloudflare's managed robots.txt is switched on for this zone. It prepends
 * its own block, which asks the AI crawlers to stay away, to whatever we
 * serve here. The two coexist: keep ours to a plain "Allow" and the sitemap
 * line and there is nothing to conflict.
 */

import { canonicalOrigin } from './meta.js';

/**
 * The pages worth listing, and which content each one is built from.
 *
 * Canonical URLs only. The Worker also answers on /index.html, /services.html
 * and so on, but those redirect and have no business in a sitemap.
 *
 * The source names are keys of what lastModified() returns. Every page names
 * "settings" because the footer's contact details sit on all of them, so
 * changing a phone number genuinely does change every page.
 *
 * Adding a page to this list is all a new page needs. If you add one, add it
 * to PAGES in index.js too, or the Worker will not render its content.
 */
const PAGES = [
  { path: '/', sources: ['featured', 'reviews', 'settings'] },
  { path: '/services', sources: ['services', 'settings'] },
  { path: '/gallery', sources: ['gallery', 'photos', 'settings'] },
  { path: '/contact', sources: ['services', 'settings'] },
];

/** Escape text for insertion into XML. */
function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * When each kind of content was last touched.
 *
 * The gallery needs two of these. A project whose photos were changed but
 * whose caption was not comes back from the API with its updated_at untouched,
 * because there was no column to write. Replacing the photos does delete and
 * reinsert every row in gallery_images, so their created_at is an accurate
 * record of when the pictures last changed.
 */
async function lastModified(env) {
  const results = await env.DB.batch([
    env.DB.prepare(`SELECT MAX(updated_at) AS t FROM services WHERE show_on_home = 1`),
    env.DB.prepare(`SELECT MAX(updated_at) AS t FROM services WHERE show_on_services = 1`),
    env.DB.prepare(`SELECT MAX(updated_at) AS t FROM gallery WHERE published = 1`),
    env.DB.prepare(
      `SELECT MAX(gi.created_at) AS t
         FROM gallery_images gi
         JOIN gallery g ON g.id = gi.gallery_id
        WHERE g.published = 1`
    ),
    env.DB.prepare(`SELECT MAX(updated_at) AS t FROM testimonials WHERE published = 1`),
    env.DB.prepare(`SELECT MAX(updated_at) AS t FROM settings`),
  ]);

  // MAX over no rows is a single row holding null, so every query answers.
  const at = (i) => (results[i].results[0] && results[i].results[0].t) || null;

  return {
    featured: at(0),
    services: at(1),
    gallery: at(2),
    photos: at(3),
    reviews: at(4),
    settings: at(5),
  };
}

/**
 * The most recent of a page's sources.
 *
 * D1 stores these as "2026-08-15 22:03:44" in UTC, a format that sorts as text
 * in the same order it sorts in time, so there is nothing to parse.
 */
function newest(times, sources) {
  const found = sources.map((source) => times[source]).filter(Boolean);
  return found.length ? found.sort()[found.length - 1] : null;
}

/** "2026-08-15 22:03:44" to the W3C datetime a sitemap asks for. */
function w3c(value) {
  return value ? `${value.replace(' ', 'T')}Z` : null;
}

export async function sitemap(env, url) {
  const origin = canonicalOrigin(url);
  let times = {};
  try {
    times = await lastModified(env);
  } catch (err) {
    // A sitemap with no dates in it is still a valid and useful sitemap.
    // Refusing to serve one because a timestamp could not be read would be
    // the worse answer.
    console.error('sitemap dates unavailable, listing pages without them', err);
  }

  // No changefreq and no priority. Google ignores both, and a number nobody
  // maintains is worse than no number at all.
  const urls = PAGES.map((page) => {
    const at = w3c(newest(times, page.sources));
    return (
      '  <url>\n' +
      `    <loc>${xml(origin + page.path)}</loc>\n` +
      (at ? `    <lastmod>${at}</lastmod>\n` : '') +
      '  </url>'
    );
  }).join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      // Long enough that a crawler cannot make work for the database, short
      // enough that an edit shows up the same day.
      'Cache-Control': 'public, max-age=3600',
    },
  });
}

/**
 * The admin is already behind a sign-in and already says noindex, so this is
 * about not wasting a crawler's time rather than about keeping anything
 * secret. Nothing links to either path.
 */
export function robots(url) {
  const body = `User-agent: *
Allow: /
Disallow: /admin
Disallow: /api/

Sitemap: ${canonicalOrigin(url)}/sitemap.xml
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
