/**
 * Shaws Carpentry site Worker.
 *
 * The four public pages are ordinary static HTML in public/. This Worker runs
 * ahead of them (see run_worker_first in wrangler.toml) and swaps the contents
 * of the containers marked with data-content for whatever is currently in the
 * database. The page still leaves the edge as complete HTML, so search engines
 * see the services and photos, and an edit shows up immediately without a
 * rebuild.
 *
 * Everything else (CSS, JS, images) is served straight from the asset server.
 */

import {
  loadContent,
  servicesGrid,
  featuredServices,
  galleryGrid,
  testimonialsGrid,
  contactInfo,
  serviceOptions,
  footerContact,
} from './content.js';

/** Paths whose HTML gets content injected. */
const PAGES = new Set([
  '/',
  '/index.html',
  '/services',
  '/services.html',
  '/gallery',
  '/gallery.html',
  '/contact',
  '/contact.html',
]);

/** Replaces the inner HTML of whichever container it is attached to. */
class SetInner {
  constructor(html) {
    this.html = html;
  }
  element(el) {
    el.setInnerContent(this.html, { html: true });
  }
}

/** Same, but also rewrites the container's class attribute. */
class SetInnerAndClass {
  constructor(html, className) {
    this.html = html;
    this.className = className;
  }
  element(el) {
    el.setAttribute('class', this.className);
    el.setInnerContent(this.html, { html: true });
  }
}

/** Points the contact form at the endpoint stored in settings. */
class SetFormEndpoint {
  constructor(endpoint, email) {
    this.endpoint = endpoint;
    this.email = email;
  }
  element(el) {
    if (this.endpoint) el.setAttribute('data-endpoint', this.endpoint);
    if (this.email) el.setAttribute('data-email', this.email);
  }
}

function buildRewriter(content) {
  const reviews = testimonialsGrid(content);

  return new HTMLRewriter()
    .on('[data-content="services-domestic"]', new SetInner(servicesGrid(content, 'domestic')))
    .on('[data-content="services-commercial"]', new SetInner(servicesGrid(content, 'commercial')))
    .on('[data-content="featured-services"]', new SetInner(featuredServices(content)))
    .on('[data-content="gallery"]', new SetInner(galleryGrid(content)))
    .on(
      '[data-content="testimonials"]',
      new SetInnerAndClass(reviews.html, reviews.className)
    )
    .on('[data-content="contact-info"]', new SetInner(contactInfo(content)))
    .on('[data-content="service-options"]', new SetInner(serviceOptions(content)))
    .on('[data-content="footer-contact"]', new SetInner(footerContact(content)))
    .on(
      '#contact-form',
      new SetFormEndpoint(content.setting.form_endpoint, content.setting.email)
    );
}

async function renderPage(request, env) {
  // Ask the asset server for this exact path. Requesting the underlying
  // "*.html" file instead would come back as a 307 to the extensionless URL,
  // which is also why legacy /services.html links simply pass through here.
  const assetResponse = await env.ASSETS.fetch(request);

  if (!assetResponse.ok) return assetResponse;

  const contentType = assetResponse.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return assetResponse;

  let content;
  try {
    content = await loadContent(env);
  } catch (err) {
    // If the database is unreachable, serve the static page untouched rather
    // than showing an error. It still has the last-published content in it.
    console.error('content load failed, serving static page', err);
    return assetResponse;
  }

  const response = new Response(assetResponse.body, assetResponse);
  response.headers.set('Cache-Control', 'no-cache');
  return buildRewriter(content).transform(response);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Treat /services/ the same as /services.
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    if (PAGES.has(path)) return renderPage(request, env);

    return env.ASSETS.fetch(request);
  },
};
