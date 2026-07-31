/**
 * Visitor statistics, recorded by the site itself.
 *
 * No cookies, no third party, and nothing identifying kept. See
 * db/migrations/002-page-views.sql for what is stored and why the site
 * therefore needs no cookie banner.
 */

/** Obvious crawlers. Keeping them out stops the numbers flattering Stuart. */
const BOT_PATTERN =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|monitor|uptime|curl|wget|python-requests|axios|lighthouse|pingdom|semrush|ahrefs|screaming frog/i;

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Where the visitor came from: the referring site's hostname, or 'direct'.
 * Traffic from our own pages is not a source, it is someone browsing.
 */
function sourceOf(request, url) {
  const referrer = request.headers.get('Referer');
  if (!referrer) return 'direct';
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    if (host === url.hostname.replace(/^www\./, '')) return 'internal';
    return host.slice(0, 100);
  } catch {
    return 'direct';
  }
}

/**
 * Records one page view. Call inside ctx.waitUntil so the visitor never waits
 * on it, and so a database hiccup can never break the page.
 */
export async function recordView(request, env, url) {
  try {
    if (!env.DB) return;

    const userAgent = request.headers.get('User-Agent') || '';
    if (!userAgent || BOT_PATTERN.test(userAgent)) return;

    const source = sourceOf(request, url);
    if (source === 'internal') {
      // Still a page view, just not a new arrival from somewhere.
    }

    const day = today();
    const ip = request.headers.get('CF-Connecting-IP') || '';
    // The IP is used to compute the hash and then discarded; it is never
    // written anywhere.
    const visitor = (
      await sha256Hex(`${env.ANALYTICS_SALT || 'unsalted'}|${day}|${ip}|${userAgent}`)
    ).slice(0, 24);

    await env.DB.prepare(
      `INSERT INTO page_views (day, path, source, visitor) VALUES (?, ?, ?, ?)`
    )
      .bind(day, url.pathname.slice(0, 200), source, visitor)
      .run();

    // Occasionally drop very old rows so the table cannot grow forever.
    if (Math.random() < 0.01) {
      await env.DB.prepare(
        `DELETE FROM page_views WHERE day < date('now', '-400 days')`
      ).run();
    }
  } catch (err) {
    console.error('could not record page view', err);
  }
}

/** Fills in days with no visitors so the chart has no gaps. */
function fillDays(rows, days) {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    out.push({ day: key, views: row ? row.views : 0, visitors: row ? row.visitors : 0 });
  }
  return out;
}

/** Everything the admin's Visitors tab needs, in one round of queries. */
export async function readStats(env, days = 30) {
  const since = `date('now', '-${Math.max(1, Math.min(days, 400)) - 1} days')`;
  const previousSince = `date('now', '-${days * 2 - 1} days')`;
  const previousUntil = `date('now', '-${days} days')`;

  const [daily, sources, current, previous] = await env.DB.batch([
    env.DB.prepare(
      `SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM page_views WHERE day >= ${since}
        GROUP BY day ORDER BY day`
    ),
    // Each visitor is credited to one source: where they first arrived that
    // day. Attributing per page view instead meant someone who came from
    // Google and later returned directly was counted under both, and anyone
    // whose first recorded view was internal navigation appeared under
    // neither, so the rows never summed to the visitor total.
    //
    // A visitor with no external referrer at all counts as direct, which is
    // the usual convention.
    env.DB.prepare(
      `SELECT entry.source AS source, COUNT(*) AS visitors
         FROM (
           SELECT p.day, p.visitor,
                  COALESCE((
                    SELECT p2.source FROM page_views p2
                     WHERE p2.day = p.day
                       AND p2.visitor = p.visitor
                       AND p2.source != 'internal'
                     ORDER BY p2.id LIMIT 1
                  ), 'direct') AS source
             FROM page_views p
            WHERE p.day >= ${since}
            GROUP BY p.day, p.visitor
         ) AS entry
        GROUP BY entry.source
        ORDER BY visitors DESC, source`
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM page_views WHERE day >= ${since}`
    ),
    env.DB.prepare(
      `SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors
         FROM page_views WHERE day >= ${previousSince} AND day < ${previousUntil}`
    ),
  ]);

  // Keep the list short, but fold the tail into "Other" rather than dropping
  // it, so the rows still add up to the visitor total.
  const TOP = 10;
  let rows = sources.results;
  if (rows.length > TOP + 1) {
    const head = rows.slice(0, TOP);
    const tail = rows.slice(TOP);
    head.push({
      source: `${tail.length} other sources`,
      visitors: tail.reduce((sum, r) => sum + r.visitors, 0),
    });
    rows = head;
  }

  return {
    days,
    daily: fillDays(daily.results, days),
    sources: rows,
    total: current.results[0] || { views: 0, visitors: 0 },
    previous: previous.results[0] || { views: 0, visitors: 0 },
  };
}
