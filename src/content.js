/**
 * Reads editable content out of D1 and turns it into the HTML fragments the
 * public pages expect.
 *
 * The markup here mirrors what was originally hand-written in public/*.html,
 * so a page rendered from the database is indistinguishable from the static
 * original. If you change a card's markup in the HTML, change it here too.
 */

/** Escape text for insertion into HTML. */
export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Fetch every piece of content a page might need, in one round of queries. */
export async function loadContent(env) {
  const [services, gallery, galleryImages, testimonials, settings] = await env.DB.batch([
    env.DB.prepare(
      `SELECT category, title, description, image_key, image_alt, featured, sort_order
         FROM services WHERE published = 1
        ORDER BY category, sort_order, id`
    ),
    env.DB.prepare(
      `SELECT id, caption
         FROM gallery WHERE published = 1
        ORDER BY sort_order, id`
    ),
    env.DB.prepare(
      `SELECT gi.gallery_id, gi.image_key, gi.image_alt
         FROM gallery_images gi
         JOIN gallery g ON g.id = gi.gallery_id
        WHERE g.published = 1
        ORDER BY gi.gallery_id, gi.sort_order, gi.id`
    ),
    env.DB.prepare(
      `SELECT quote, author_name, author_town
         FROM testimonials WHERE published = 1
        ORDER BY sort_order, id`
    ),
    env.DB.prepare(`SELECT key, value FROM settings`),
  ]);

  const setting = {};
  for (const row of settings.results) setting[row.key] = row.value;

  // Attach each project's photos, in order. A project with no photos is
  // skipped rather than rendered as an empty tile.
  const imagesByGallery = new Map();
  for (const row of galleryImages.results) {
    if (!imagesByGallery.has(row.gallery_id)) imagesByGallery.set(row.gallery_id, []);
    imagesByGallery.get(row.gallery_id).push({ src: row.image_key, alt: row.image_alt });
  }

  const galleryProjects = gallery.results
    .map((project) => ({ ...project, images: imagesByGallery.get(project.id) || [] }))
    .filter((project) => project.images.length > 0);

  return {
    services: services.results,
    gallery: galleryProjects,
    testimonials: testimonials.results,
    setting,
  };
}

/* ---------------------------------------------------------------- services */

function serviceCard(s, withLink) {
  const media = s.image_key
    ? `<div class="card__media"><img src="${esc(s.image_key)}" alt="${esc(s.image_alt)}" loading="lazy"></div>`
    : '';
  const link = withLink
    ? `\n              <a class="card__link" href="/services">Learn more <span aria-hidden="true">&rarr;</span></a>`
    : '';
  return `
          <article class="card reveal">
            ${media}
            <div class="card__body">
              <h3>${esc(s.title)}</h3>
              <p>${esc(s.description)}</p>${link}
            </div>
          </article>`;
}

/**
 * The "Something Else in Mind?" cards are page furniture rather than services,
 * so they are not stored in the database and cannot be deleted by accident.
 */
function enquireCard(body) {
  return `
          <article class="card card--enquire reveal">
            <div class="card__body" style="justify-content: center; text-align: center; gap: var(--space-2);">
              <h3>Something Else in Mind?</h3>
              <p>${body}</p>
              <a class="btn btn--primary" href="/contact">Ask Us About It</a>
            </div>
          </article>`;
}

const ENQUIRE_DOMESTIC = enquireCard(
  "If it&#39;s made of wood, we can probably help. Tell us what you&#39;re planning and we&#39;ll give you honest advice."
);

const ENQUIRE_COMMERCIAL = enquireCard(
  "Every fit-out is different. Tell us what your premises need and we&#39;ll come back with honest advice, timescales and a clear price."
);

export function servicesGrid(content, category) {
  const cards = content.services
    .filter((s) => s.category === category)
    .map((s) => serviceCard(s, false))
    .join('');
  const enquire = category === 'domestic' ? ENQUIRE_DOMESTIC : ENQUIRE_COMMERCIAL;
  return cards + enquire + '\n        ';
}

export function featuredServices(content) {
  const cards = content.services
    .filter((s) => s.featured)
    .map((s) => serviceCard(s, true))
    .join('');
  return cards + '\n        ';
}

/* ----------------------------------------------------------------- gallery */

export function galleryGrid(content) {
  return (
    content.gallery
      .map((g) => {
        const cover = g.images[0];
        const count = g.images.length;
        // The whole set travels with the tile so the carousel can open
        // instantly without another request.
        const payload = esc(JSON.stringify(g.images));
        const label =
          count > 1
            ? `View ${count} photos: ${g.caption}`
            : `View larger: ${g.caption}`;
        const badge =
          count > 1
            ? `\n            <span class="gallery-item__count">${count} photos</span>`
            : '';
        return `
          <figure class="gallery-item reveal" tabindex="0" role="button" aria-label="${esc(label)}" data-images="${payload}">
            <img src="${esc(cover.src)}" alt="${esc(cover.alt)}" loading="lazy">${badge}
            <figcaption>${esc(g.caption)}</figcaption>
          </figure>`;
      })
      .join('') + '\n        '
  );
}

/* ------------------------------------------------------------ testimonials */

const REVIEWS_PENDING = `
          <figure class="quote quote--pending reveal">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7.17 5.5A5.67 5.67 0 0 0 1.5 11.17v7.33h7.33v-7.33H5.17a2 2 0 0 1 2-2zm11.66 0a5.67 5.67 0 0 0-5.67 5.67v7.33h7.34v-7.33h-3.67a2 2 0 0 1 2-2z"/></svg>
            <blockquote>Reviews coming soon</blockquote>
            <p>We are gathering feedback from our most recent customers, and their words will appear here shortly. If we have worked on your home or premises, we would love to hear how we did.</p>
          </figure>
        `;

/**
 * With no published reviews the page keeps its "Reviews coming soon" card, so
 * the site never looks half-finished. The grid class changes with it: one
 * centred card while pending, a three-column grid once reviews exist.
 */
export function testimonialsGrid(content) {
  if (content.testimonials.length === 0) {
    return { className: 'quote-grid quote-grid--single', html: REVIEWS_PENDING };
  }
  const html =
    content.testimonials
      .map((t) => {
        const who = t.author_town
          ? `${esc(t.author_name)}, ${esc(t.author_town)}`
          : esc(t.author_name);
        return `
          <figure class="quote reveal">
            <blockquote>"${esc(t.quote)}"</blockquote>
            <figcaption>${who}</figcaption>
          </figure>`;
      })
      .join('') + '\n        ';
  return { className: 'quote-grid', html };
}

/* ----------------------------------------------------------------- contact */

const ICONS = {
  phone:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  email:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
  area:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  hours:
    '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
};

function infoItem(icon, heading, body) {
  return `
            <div class="contact-info__item reveal">
              ${icon}
              <div>
                <h3>${heading}</h3>
                <p>${body}</p>
              </div>
            </div>`;
}

export function contactInfo(content) {
  const s = content.setting;
  const areas = [s.areas_domestic, s.areas_commercial].filter(Boolean).map(esc).join('<br>');
  const hours = [s.hours_weekday, s.hours_weekend].filter(Boolean).map(esc).join('<br>');
  return (
    infoItem(ICONS.phone, 'Phone', `<a href="tel:${esc(s.phone_href)}">${esc(s.phone_display)}</a>`) +
    infoItem(ICONS.email, 'Email', `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`) +
    infoItem(ICONS.area, 'Service Area', areas) +
    infoItem(ICONS.hours, 'Hours', hours) +
    '\n          '
  );
}

export function serviceOptions(content) {
  const group = (label, category, otherLabel) => {
    const options = content.services
      .filter((s) => s.category === category)
      .map((s) => `\n                  <option>${esc(s.title)}</option>`)
      .join('');
    return `
                <optgroup label="${label}">${options}
                  <option>${otherLabel}</option>
                </optgroup>`;
  };
  return (
    '\n                <option value="">Choose a service (optional)</option>' +
    group('Domestic', 'domestic', 'Something else (Domestic)') +
    group('Commercial', 'commercial', 'Something else (Commercial)') +
    '\n              '
  );
}

export function footerContact(content) {
  const s = content.setting;
  const lines = [
    `<a href="tel:${esc(s.phone_href)}">${esc(s.phone_display)}</a>`,
    `<a href="mailto:${esc(s.email)}">${esc(s.email)}</a>`,
    esc(s.areas_domestic_short),
    esc(s.areas_commercial_short),
  ].filter(Boolean);
  return lines.map((l) => `\n            <li>${l}</li>`).join('') + '\n          ';
}
