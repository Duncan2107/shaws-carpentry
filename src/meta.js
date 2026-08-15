/**
 * The tags a search engine and a social scraper read: the canonical URL, and
 * the Open Graph card that decides what a shared link looks like.
 *
 * Almost all of it is worked out from what the page already says. The title
 * and the description are read back out of the page's own head, the locale
 * comes from the <html lang> attribute, and the address comes from the
 * request. That leaves exactly one thing for a page to declare for itself:
 *
 *     <meta property="og:image" content="/Media/decking.jpg">
 *
 * written root-relative, because the Worker turns it into an absolute URL and
 * a scraper will not accept a relative one. Which photograph represents a page
 * is an editorial choice, so it belongs next to that page's title and
 * description rather than in a lookup table in here. A page without the line
 * still gets a card, just a small one with no picture.
 */

/**
 * The origin this site should call itself by.
 *
 * Taken from the request, so everything here is correct on whatever domain the
 * Worker answers on and there is nothing per-site to edit. The scheme is
 * forced to https because a canonical tag or a sitemap naming http:// is
 * naming a different address from the one the site serves, and Google counts
 * them as different pages. Local development is the one place http is real.
 */
export function canonicalOrigin(url) {
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return local ? url.origin : `https://${url.host}`;
}

/** Escape a value for use inside a double-quoted HTML attribute. */
function attr(value) {
  // Deliberately not touching &. These values are read back out of the page's
  // own markup, where an ampersand already arrives as &amp;, and escaping it
  // again would print the entity instead of the character.
  return String(value).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * What the page told us about itself, filled in as the head streams past.
 *
 * HTMLRewriter reads in one pass and cannot look ahead, which is the reason
 * the share image has to be declared in the head rather than picked up from
 * the hero photograph further down the page: by the time the hero is parsed,
 * </head> has already gone out.
 */
function newCollected() {
  return { title: '', description: '', locale: '', hasImage: false };
}

/** Accumulates the page title. Long text can arrive in several chunks. */
class CollectTitle {
  constructor(collected) {
    this.collected = collected;
  }
  text(chunk) {
    this.collected.title += chunk.text;
  }
}

/** Reads the description the page already carries, rather than repeating it. */
class CollectDescription {
  constructor(collected) {
    this.collected = collected;
  }
  element(el) {
    this.collected.description = el.getAttribute('content') || '';
  }
}

/** Open Graph wants en_GB where HTML writes en-GB. */
class CollectLocale {
  constructor(collected) {
    this.collected = collected;
  }
  element(el) {
    const lang = el.getAttribute('lang');
    if (lang) this.collected.locale = lang.replace('-', '_');
  }
}

/** Turns the page's root-relative share image into an absolute URL. */
class AbsoluteImage {
  constructor(collected, origin) {
    this.collected = collected;
    this.origin = origin;
  }
  element(el) {
    const value = el.getAttribute('content');
    if (!value) return;
    this.collected.hasImage = true;
    if (value.startsWith('/')) el.setAttribute('content', this.origin + value);
  }
}

/**
 * Writes the tags in just before </head>, which is the only moment at which
 * the title and description have been seen but the head is still open.
 */
class HeadTags {
  constructor(collected, canonical, siteName) {
    this.collected = collected;
    this.canonical = canonical;
    this.siteName = siteName;
  }

  element(el) {
    el.onEndTag((end) => {
      end.before(this.render(), { html: true });
    });
  }

  render() {
    const { title, description, locale, hasImage } = this.collected;
    const clean = title.trim();

    const tags = [
      `<link rel="canonical" href="${attr(this.canonical)}">`,
      '<meta property="og:type" content="website">',
      this.siteName ? `<meta property="og:site_name" content="${attr(this.siteName)}">` : '',
      locale ? `<meta property="og:locale" content="${attr(locale)}">` : '',
      `<meta property="og:url" content="${attr(this.canonical)}">`,
      clean ? `<meta property="og:title" content="${attr(clean)}">` : '',
      description ? `<meta property="og:description" content="${attr(description)}">` : '',
      // X and the others fall back to the Open Graph tags for the title, the
      // description and the picture, so this is the only one worth stating.
      // A card with no picture is a small card, not a broken one.
      `<meta name="twitter:card" content="${hasImage ? 'summary_large_image' : 'summary'}">`,
    ].filter(Boolean);

    return '\n  ' + tags.join('\n  ') + '\n';
  }
}

/**
 * Attach the handlers to a rewriter.
 *
 * `siteName` is the business_name setting. It is the one settings value read
 * here, named explicitly for the same reason src/content.js names the keys it
 * uses: the settings table also holds bank details, and nothing should reach a
 * public page by accident.
 */
export function addMetaTags(rewriter, url, canonical, siteName) {
  const collected = newCollected();
  const origin = canonicalOrigin(url);

  return rewriter
    .on('html', new CollectLocale(collected))
    .on('head > title', new CollectTitle(collected))
    .on('head > meta[name="description"]', new CollectDescription(collected))
    .on('head > meta[property="og:image"]', new AbsoluteImage(collected, origin))
    .on('head', new HeadTags(collected, canonical, siteName));
}
