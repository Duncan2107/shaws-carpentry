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
import { requireAdmin, json } from './auth.js';
import { handleApi } from './api.js';

// Fallback asset version for local development, where there is no deployment
// id. It changes whenever the dev server restarts, which is exactly when the
// files may have changed.
const BOOT_ID = Date.now().toString(36);

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

/**
 * Stamps the stylesheet and script URLs with the current deployment id.
 *
 * Without this a browser can keep serving a cached main.js against freshly
 * rendered markup, which breaks quietly and only for people who visited
 * before. The id changes on every deploy, so the URL does too.
 */
class VersionAssets {
  constructor(version) {
    this.version = version;
  }
  element(el) {
    const attr = el.tagName === 'link' ? 'href' : 'src';
    const value = el.getAttribute(attr);
    if (value && !value.includes('?')) {
      el.setAttribute(attr, `${value}?v=${this.version}`);
    }
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

function buildRewriter(content, assetVersion) {
  const reviews = testimonialsGrid(content);

  return new HTMLRewriter()
    .on('link[rel="stylesheet"][href^="/css/"]', new VersionAssets(assetVersion))
    .on('script[src^="/js/"]', new VersionAssets(assetVersion))
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
  const assetVersion = (env.CF_VERSION && env.CF_VERSION.id ? env.CF_VERSION.id : BOOT_ID).slice(0, 8);
  return buildRewriter(content, assetVersion).transform(response);
}

/**
 * Shown when someone reaches /admin without a valid session.
 *
 * In normal use Cloudflare Access presents its own sign-in screen first, so
 * this is the fallback for the workers.dev address and for before Access has
 * been configured. It explains the situation instead of showing a bare error.
 */
function signInPage(status) {
  const notConfigured = status === 503;
  const message = notConfigured
    ? 'The sign-in system has not been switched on for this site yet.'
    : 'You need to sign in before you can manage the website.';
  const detail = notConfigured
    ? 'Once Cloudflare Access is set up, visiting this page will ask for your email address and send you a one-time code.'
    : 'Reload this page and you will be asked for your email address. A one-time code will be sent to you, and no password is needed.';

  const html = `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Sign in | Shaws Carpentry</title>
<link rel="icon" href="/Media/logo.png" type="image/png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600&family=Jost:wght@300;400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/styles.css">
<style>
  body { display: grid; place-items: center; min-height: 100svh; padding: var(--space-3); }
  .signin { max-width: 30rem; text-align: center; background: var(--white);
            border: 1px solid var(--line); border-radius: var(--radius);
            padding: var(--space-6) var(--space-4); box-shadow: var(--shadow-md); }
  .signin img { height: 4.5rem; width: auto; margin: 0 auto var(--space-3); }
  .signin h1 { font-size: 1.5rem; margin-bottom: var(--space-2); }
  .signin p { color: var(--text-muted); margin-bottom: var(--space-2); }
  .signin .btn { margin-top: var(--space-2); }
</style>
</head>
<body>
  <main class="signin">
    <img src="/Media/logo.png" alt="Shaws Carpentry" width="260" height="228">
    <h1>${message}</h1>
    <p>${detail}</p>
    <a class="btn btn--primary" href="/admin">Try again</a>
    <p style="margin-top:var(--space-3)"><a href="/">Back to the website</a></p>
  </main>
</body>
</html>`;

  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Serves an uploaded photo out of R2. */
async function servePhoto(request, env, key) {
  if (!env.PHOTOS) return new Response('Photo storage not configured.', { status: 503 });
  if (!key) return new Response('Not found.', { status: 404 });

  const object = await env.PHOTOS.get(key);
  if (!object) return new Response('Not found.', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // Uploads get a content-hashed name, so they can be cached hard.
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return new Response(object.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Send www to the bare domain so a page has one address, not two. This is
    // what Netlify did before the move, so existing links keep working.
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }

    // Treat /services/ the same as /services.
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

    if (path.startsWith('/img/')) {
      return servePhoto(request, env, decodeURIComponent(path.slice('/img/'.length)));
    }

    if (path === '/api' || path.startsWith('/api/')) {
      const auth = await requireAdmin(request, env);
      if (!auth.ok) return auth.response;
      return handleApi(request, env, path);
    }

    if (path === '/admin' || path.startsWith('/admin/')) {
      const auth = await requireAdmin(request, env);
      if (!auth.ok) {
        // Access normally shows its own sign-in screen before the request
        // ever reaches the Worker. Landing here means it arrived somewhere
        // Access does not cover, or it is not set up yet.
        return signInPage(auth.response.status);
      }
      // Let the asset server resolve /admin to admin/index.html itself, the
      // same way it does for the public pages.
      const response = await env.ASSETS.fetch(request);
      const copy = new Response(response.body, response);
      copy.headers.set('Cache-Control', 'no-store');
      return copy;
    }

    if (PAGES.has(path)) return renderPage(request, env);

    return env.ASSETS.fetch(request);
  },
};
