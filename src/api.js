/**
 * Admin API behind Cloudflare Access.
 *
 * Every route here is gated by requireAdmin() in the router before it is
 * reached, so these handlers assume the caller is already authenticated.
 */

import { json } from './auth.js';
import { readStats } from './analytics.js';

/**
 * Which columns each collection accepts, and how to validate them.
 *
 * Anything not listed is ignored rather than written, so a stray field in a
 * request body can never reach the database.
 */
const COLLECTIONS = {
  services: {
    table: 'services',
    fields: {
      category: { type: 'enum', values: ['domestic', 'commercial'], required: true },
      title: { type: 'text', required: true, max: 120 },
      description: { type: 'text', required: true, max: 1000 },
      image_key: { type: 'text', max: 300, nullable: true },
      image_alt: { type: 'text', max: 300, default: '' },
      // Independent switches: a service can be on either page, both, or
      // neither. See db/migrations/001-split-home-and-services.sql.
      show_on_home: { type: 'bool', default: 0 },
      show_on_services: { type: 'bool', default: 1 },
      sort_order: { type: 'int', default: 0 },
    },
  },
  gallery: {
    table: 'gallery',
    // Photos are handled separately: see replaceGalleryImages.
    hasImages: true,
    fields: {
      caption: { type: 'text', required: true, max: 120 },
      sort_order: { type: 'int', default: 0 },
      published: { type: 'bool', default: 1 },
    },
  },
  testimonials: {
    table: 'testimonials',
    fields: {
      quote: { type: 'text', required: true, max: 1000 },
      author_name: { type: 'text', required: true, max: 120 },
      author_town: { type: 'text', max: 120, default: '' },
      sort_order: { type: 'int', default: 0 },
      published: { type: 'bool', default: 0 },
    },
  },
  documents: {
    table: 'documents',
    // The admin suggests the next reference but the client sets it, so it can
    // follow whatever numbering the business already uses. It is required,
    // and unique: nothing may share a reference with anything else.
    issuesRefs: true,
    jsonFields: ['tasks'],
    order: 'issue_date DESC, id DESC',
    fields: {
      ref: { type: 'text', required: true, max: 40 },
      doc_type: { type: 'enum', values: ['quote', 'invoice'], default: 'quote' },
      // Which statuses are allowed depends on doc_type: see DOC_TYPES.
      status: { type: 'text', max: 20, default: '' },
      issue_date: { type: 'text', max: 10, default: '' },
      due_date: { type: 'text', max: 10, default: '', nullable: true },
      title: { type: 'text', max: 200, default: '' },
      customer_name: { type: 'text', max: 200, default: '' },
      customer_phone: { type: 'text', max: 60, default: '' },
      customer_email: { type: 'text', max: 200, default: '' },
      job_address: { type: 'text', max: 300, default: '' },
      notes: { type: 'text', max: 4000, default: '' },
      vat_rate: { type: 'number', min: 0, max: 100, default: 0 },
      price_view: { type: 'enum', values: ['full', 'summary', 'totals'], default: 'full' },
      tasks: { type: 'json', maxBytes: 100000, default: '[]' },
      sort_order: { type: 'int', default: 0 },
    },
  },
};

/**
 * The two kinds of document, and what each one is allowed to be.
 *
 * A job moves quote -> invoice on the same row, keeping the reference it held
 * as a quote, so an invoice can still show where it came from. Accepted work
 * in progress is a quote marked Accepted rather than a third kind of document.
 * "Overdue" is not stored: it is an unpaid invoice past its due date, worked
 * out when the list is drawn.
 *
 * The `order_ref` column is left in the table from an earlier design. It costs
 * nothing, and removing a column from D1 is more trouble than leaving it.
 */
const DOC_TYPES = {
  quote: {
    prefix: 'Q',
    column: 'quote_ref',
    statuses: ['draft', 'sent', 'accepted', 'declined'],
    opening: 'draft',
  },
  invoice: {
    prefix: 'INV',
    column: 'invoice_ref',
    statuses: ['draft', 'sent', 'paid'],
    opening: 'draft',
  },
};

const DOC_ORDER = ['quote', 'invoice'];

const SETTING_KEYS = new Set([
  'phone_display',
  'phone_href',
  'email',
  'areas_domestic',
  'areas_commercial',
  'areas_domestic_short',
  'areas_commercial_short',
  'hours_weekday',
  'hours_weekend',
  'form_endpoint',
  // Printed on quotes, orders and invoices. Entered once here so they can
  // never disagree with what the website says. None of these is rendered on a
  // public page: src/content.js names the keys it uses.
  'business_name',
  'business_address',
  'vat_number',
  'bank_account_name',
  'bank_sort_code',
  'bank_account_number',
  'payment_terms_days',
  // Starting figures for a new quote, not contact details.
  'quote_markup',
  'quote_hourly_rate',
  'quote_day_rate',
  'quote_vat',
]);

class ValidationError extends Error {}

/**
 * Accepted image types, identified by the bytes themselves rather than the
 * Content-Type header. A client can claim anything; the file's own signature
 * is harder to lie about, and these files get served back to the public.
 */
const IMAGE_SIGNATURES = [
  { ext: 'jpg', type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'png', type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'webp', type: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0, also: { at: 8, bytes: [0x57, 0x45, 0x42, 0x50] } },
];

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

function identifyImage(bytes) {
  for (const sig of IMAGE_SIGNATURES) {
    const matches = sig.bytes.every((b, i) => bytes[i] === b);
    if (!matches) continue;
    if (sig.also && !sig.also.bytes.every((b, i) => bytes[sig.also.at + i] === b)) continue;
    return sig;
  }
  return null;
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Stores an uploaded photo in R2 and returns the path to serve it from.
 *
 * The admin shrinks images in the browser before sending, so what arrives is
 * already web-sized. The checks here are not about trusting that: they are
 * because anything reachable from the public /img/ route needs to actually be
 * an image, whatever the client claimed.
 */
async function handleUpload(request, env) {
  if (!env.PHOTOS) return json({ error: 'Photo storage is not set up yet.' }, 503);

  let form;
  try {
    form = await request.formData();
  } catch {
    // Malformed or missing body. Answer plainly rather than letting the
    // parser's own error surface.
    return json({ error: 'No photo was received. Please choose a file and try again.' }, 400);
  }

  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return json({ error: 'No file was included.' }, 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json({ error: 'That photo is too large. Please use one under 8MB.' }, 400);
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer.slice(0, 16));
  const signature = identifyImage(bytes);
  if (!signature) {
    return json({ error: 'That file is not a JPEG, PNG or WebP image.' }, 400);
  }

  // Name by content hash: uploading the same photo twice reuses one object,
  // and the name can never contain anything awkward from the original.
  const hash = await sha256Hex(buffer);
  const key = `${hash.slice(0, 32)}.${signature.ext}`;

  await env.PHOTOS.put(key, buffer, {
    httpMetadata: { contentType: signature.type, cacheControl: 'public, max-age=31536000, immutable' },
  });

  return json({ key, url: `/img/${key}`, type: signature.type, bytes: buffer.byteLength }, 201);
}

function coerce(name, spec, raw, { partial }) {
  if (raw === undefined) {
    if (partial) return undefined;
    if (spec.required) throw new ValidationError(`${name} is required.`);
    return spec.default !== undefined ? spec.default : null;
  }

  switch (spec.type) {
    case 'enum':
      if (!spec.values.includes(raw)) {
        throw new ValidationError(`${name} must be one of: ${spec.values.join(', ')}`);
      }
      return raw;
    case 'bool':
      return raw ? 1 : 0;
    case 'int': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ValidationError(`${name} must be a number.`);
      return Math.trunc(n);
    }
    // Unlike 'text', where max is a length, here min and max are the range.
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ValidationError(`${name} must be a number.`);
      if (spec.min !== undefined && n < spec.min) {
        throw new ValidationError(`${name} cannot be less than ${spec.min}.`);
      }
      if (spec.max !== undefined && n > spec.max) {
        throw new ValidationError(`${name} cannot be more than ${spec.max}.`);
      }
      return n;
    }
    // Stored as JSON text. Only ever read and written whole, so there is
    // nothing to gain from splitting it across tables.
    case 'json': {
      if (!Array.isArray(raw)) throw new ValidationError(`${name} must be a list.`);
      const text = JSON.stringify(raw);
      if (spec.maxBytes && text.length > spec.maxBytes) {
        throw new ValidationError(`${name} is too large to save. Split the job into fewer items.`);
      }
      return text;
    }
    case 'text':
    default: {
      const value = String(raw).trim();
      if (spec.required && !value) throw new ValidationError(`${name} cannot be empty.`);
      if (spec.max && value.length > spec.max) {
        throw new ValidationError(`${name} must be ${spec.max} characters or fewer.`);
      }
      if (!value && spec.nullable) return null;
      return value;
    }
  }
}

function buildRow(collection, body, { partial, allowEmpty }) {
  const row = {};
  for (const [name, spec] of Object.entries(collection.fields)) {
    const value = coerce(name, spec, body[name], { partial });
    if (value !== undefined) row[name] = value;
  }
  if (partial && !allowEmpty && Object.keys(row).length === 0) {
    throw new ValidationError('Nothing to update.');
  }
  return row;
}

/**
 * Replaces a project's photos with the supplied list, in the given order.
 *
 * The admin always sends the complete set, so this is a delete-then-insert
 * rather than a diff. Simpler, and it makes reordering fall out for free.
 */
async function replaceGalleryImages(env, galleryId, images) {
  if (!Array.isArray(images)) return;

  const cleaned = images
    .map((image) => ({
      image_key: String(image && image.image_key ? image.image_key : '').trim(),
      image_alt: String(image && image.image_alt ? image.image_alt : '').trim(),
    }))
    .filter((image) => image.image_key);

  if (cleaned.length === 0) {
    throw new ValidationError('A photo project needs at least one photo.');
  }

  const statements = [
    env.DB.prepare('DELETE FROM gallery_images WHERE gallery_id = ?').bind(galleryId),
  ];
  cleaned.forEach((image, i) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO gallery_images (gallery_id, image_key, image_alt, sort_order)
         VALUES (?, ?, ?, ?)`
      ).bind(galleryId, image.image_key, image.image_alt, i + 1)
    );
  });

  await env.DB.batch(statements);
}

async function attachGalleryImages(env, projects) {
  if (projects.length === 0) return projects;
  const { results } = await env.DB.prepare(
    `SELECT gallery_id, id, image_key, image_alt, sort_order
       FROM gallery_images ORDER BY gallery_id, sort_order, id`
  ).all();

  const byProject = new Map();
  for (const row of results) {
    if (!byProject.has(row.gallery_id)) byProject.set(row.gallery_id, []);
    byProject.get(row.gallery_id).push(row);
  }
  return projects.map((p) => ({ ...p, images: byProject.get(p.id) || [] }));
}

/* ------------------------------------ quotes, orders and invoices */

/** Turns the stored JSON columns back into arrays, so the browser never sees a string. */
function hydrate(collection, row) {
  if (!row || !collection.jsonFields) return row;
  const copy = { ...row };
  for (const field of collection.jsonFields) {
    try {
      const parsed = JSON.parse(copy[field]);
      copy[field] = Array.isArray(parsed) ? parsed : [];
    } catch {
      // A row that cannot be parsed is shown as an empty breakdown rather than
      // failing the whole list, which would hide every other document too.
      copy[field] = [];
    }
  }
  return copy;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function checkStatus(docType, status) {
  const spec = DOC_TYPES[docType];
  if (!spec) throw new ValidationError('Unknown kind of document.');
  if (!status) return spec.opening;
  if (!spec.statuses.includes(status)) {
    throw new ValidationError(`A ${docType} cannot be "${status}".`);
  }
  return status;
}

/**
 * The next reference for a kind of document, counted per year.
 *
 * The highest number is worked out in JavaScript rather than by sorting the
 * text in SQL, because "Q-2026-1000" sorts before "Q-2026-999".
 */
async function nextRef(env, docType) {
  const spec = DOC_TYPES[docType];
  const year = new Date().getFullYear();
  const { results } = await env.DB.prepare(
    `SELECT ${spec.column} AS ref FROM documents WHERE ${spec.column} LIKE ?`
  )
    .bind(`${spec.prefix}-${year}-%`)
    .all();

  let highest = 0;
  for (const row of results) {
    const tail = Number(String(row.ref).split('-').pop());
    if (Number.isFinite(tail) && tail > highest) highest = tail;
  }
  return `${spec.prefix}-${year}-${String(highest + 1).padStart(3, '0')}`;
}

async function settingValue(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row && row.value !== '' && row.value !== null ? row.value : fallback;
}

/**
 * Moves a job to the next stage: quote to order, or order to invoice.
 *
 * The same row changes type and takes a new reference, keeping the one it held
 * before. The issue date becomes today, because that is the date this document
 * was actually raised.
 */
async function convertDocument(env, id, to, chosenRef) {
  if (!DOC_TYPES[to]) return json({ error: 'Convert it to an invoice.' }, 400);

  const current = await env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first();
  if (!current) return json({ error: 'Not found.' }, 404);

  if (DOC_ORDER.indexOf(to) <= DOC_ORDER.indexOf(current.doc_type)) {
    return json({ error: 'A quote can become an invoice. It cannot go back.' }, 400);
  }

  const spec = DOC_TYPES[to];
  // The admin offers the next number in the sequence, but the reference is the
  // client's to set, here as much as anywhere else.
  const ref = String(chosenRef || '').trim() || (await nextRef(env, to));
  if (ref.length > 40) return json({ error: 'That reference is too long.' }, 400);
  const issueDate = todayIso();

  let dueDate = null;
  if (to === 'invoice') {
    const days = Math.trunc(Number(await settingValue(env, 'payment_terms_days', 14))) || 14;
    dueDate = addDays(issueDate, days);
  }

  const result = await env.DB.prepare(
    `UPDATE documents
        SET doc_type = ?, status = ?, ref = ?, ${spec.column} = ?,
            issue_date = ?, due_date = ?, updated_at = datetime('now')
      WHERE id = ? RETURNING *`
  )
    .bind(to, spec.opening, ref, ref, issueDate, dueDate, id)
    .first();

  return json({ item: hydrate(COLLECTIONS.documents, result) });
}

async function listAll(env) {
  const [services, gallery, testimonials, settings] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM services ORDER BY category, sort_order, id'),
    env.DB.prepare('SELECT * FROM gallery ORDER BY sort_order, id'),
    env.DB.prepare('SELECT * FROM testimonials ORDER BY sort_order, id'),
    env.DB.prepare('SELECT key, value FROM settings'),
  ]);

  const setting = {};
  for (const row of settings.results) setting[row.key] = row.value;

  return {
    services: services.results,
    gallery: await attachGalleryImages(env, gallery.results),
    testimonials: testimonials.results,
    settings: setting,
  };
}

/** Photos available to pick from, so the admin can attach one to an item. */
async function listPhotos(env) {
  const seen = new Set();

  const rows = await env.DB.batch([
    env.DB.prepare('SELECT DISTINCT image_key FROM services WHERE image_key IS NOT NULL'),
    env.DB.prepare('SELECT DISTINCT image_key FROM gallery_images'),
  ]);
  for (const result of rows) {
    for (const row of result.results) if (row.image_key) seen.add(row.image_key);
  }

  // Anything uploaded later lives in R2 and is served from /img/<key>.
  if (env.PHOTOS) {
    try {
      const listed = await env.PHOTOS.list({ limit: 500 });
      for (const object of listed.objects) seen.add(`/img/${object.key}`);
    } catch (err) {
      console.error('could not list R2 photos', err);
    }
  }

  return [...seen].sort();
}

export async function handleApi(request, env, path) {
  const segments = path.split('/').filter(Boolean); // ['api', 'services', '3']
  const [, resource, id, action] = segments;
  const method = request.method.toUpperCase();

  try {
    if (!resource || (resource === 'content' && method === 'GET')) {
      return json(await listAll(env));
    }

    if (resource === 'photos' && method === 'GET') {
      return json({ photos: await listPhotos(env) });
    }

    if (resource === 'stats' && method === 'GET') {
      const url = new URL(request.url);
      const days = Number(url.searchParams.get('days')) || 30;
      return json(await readStats(env, days));
    }

    if (resource === 'upload' && method === 'POST') {
      // Awaited, not returned directly: returning the promise would let a
      // rejection escape the catch below and surface as a raw stack trace.
      return await handleUpload(request, env);
    }

    if (resource === 'settings') {
      if (method === 'GET') {
        const { settings } = await listAll(env);
        return json({ settings });
      }
      if (method === 'PUT') {
        const body = await request.json();
        const updates = Object.entries(body).filter(([key]) => SETTING_KEYS.has(key));
        if (updates.length === 0) return json({ error: 'No known settings supplied.' }, 400);

        await env.DB.batch(
          updates.map(([key, value]) =>
            env.DB.prepare(
              `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
            ).bind(key, String(value))
          )
        );
        return json({ ok: true, updated: updates.length });
      }
      return json({ error: 'Method not allowed.' }, 405);
    }

    const collection = COLLECTIONS[resource];
    if (!collection) return json({ error: 'Unknown resource.' }, 404);

    // Reordering: POST /api/<resource>/reorder with [{id, sort_order}, ...]
    if (id === 'reorder' && method === 'POST') {
      const items = await request.json();
      if (!Array.isArray(items) || items.length === 0) {
        return json({ error: 'Expected a list of items to reorder.' }, 400);
      }
      await env.DB.batch(
        items.map((item) =>
          env.DB.prepare(
            `UPDATE ${collection.table} SET sort_order = ?, updated_at = datetime('now') WHERE id = ?`
          ).bind(Math.trunc(Number(item.sort_order) || 0), Math.trunc(Number(item.id)))
        )
      );
      return json({ ok: true, reordered: items.length });
    }

    // Moving a job on a stage: POST /api/documents/<id>/convert with {to}
    if (collection.issuesRefs && action === 'convert' && method === 'POST') {
      const numeric = Math.trunc(Number(id));
      if (!Number.isFinite(numeric) || numeric <= 0) {
        return json({ error: 'Missing or invalid id.' }, 400);
      }
      const body = await request.json();
      return await convertDocument(env, numeric, String(body.to || ''), body.ref);
    }

    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT * FROM ${collection.table} ORDER BY ${collection.order || 'sort_order, id'}`
      ).all();
      return json({ items: results.map((row) => hydrate(collection, row)) });
    }

    if (method === 'POST') {
      const body = await request.json();
      const row = buildRow(collection, body, { partial: false });

      if (collection.issuesRefs) {
        const docType = row.doc_type || 'quote';
        row.status = checkStatus(docType, row.status);
        if (!row.issue_date) row.issue_date = todayIso();
        if (!row.due_date) row.due_date = null;
        // The reference the client chose is also the one it holds at this
        // stage, which is what lets an invoice show the quote it began as.
        row[DOC_TYPES[docType].column] = row.ref;
        if (docType === 'invoice' && !row.due_date) {
          const days = Math.trunc(Number(await settingValue(env, 'payment_terms_days', 14))) || 14;
          row.due_date = addDays(row.issue_date, days);
        }
      }

      const columns = Object.keys(row);
      const placeholders = columns.map(() => '?').join(', ');
      const result = await env.DB.prepare(
        `INSERT INTO ${collection.table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`
      )
        .bind(...columns.map((c) => row[c]))
        .first();

      if (collection.hasImages) {
        try {
          await replaceGalleryImages(env, result.id, body.images);
        } catch (err) {
          // Do not leave a project behind with no photos to show.
          await env.DB.prepare('DELETE FROM gallery WHERE id = ?').bind(result.id).run();
          throw err;
        }
      }
      return json({ item: hydrate(collection, result) }, 201);
    }

    const numericId = Math.trunc(Number(id));
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return json({ error: 'Missing or invalid id.' }, 400);
    }

    if (method === 'PUT' || method === 'PATCH') {
      const body = await request.json();
      // A gallery edit may change only the photos, which is not "nothing".
      const row = buildRow(collection, body, {
        partial: true,
        allowEmpty: collection.hasImages && Array.isArray(body.images),
      });

      if (collection.issuesRefs) {
        // Changing type is what /convert is for.
        delete row.doc_type;
        if (row.status !== undefined || row.ref !== undefined) {
          const existing = await env.DB.prepare('SELECT doc_type FROM documents WHERE id = ?')
            .bind(numericId)
            .first();
          if (!existing) return json({ error: 'Not found.' }, 404);
          if (row.status !== undefined) {
            row.status = checkStatus(existing.doc_type, row.status);
          }
          // Correcting the reference has to correct the stage's copy of it too,
          // or the two would disagree the moment it is converted again.
          if (row.ref !== undefined) {
            row[DOC_TYPES[existing.doc_type].column] = row.ref;
          }
        }
      }

      let result;
      if (Object.keys(row).length > 0) {
        const assignments = Object.keys(row)
          .map((c) => `${c} = ?`)
          .join(', ');
        result = await env.DB.prepare(
          `UPDATE ${collection.table} SET ${assignments}, updated_at = datetime('now')
            WHERE id = ? RETURNING *`
        )
          .bind(...Object.keys(row).map((c) => row[c]), numericId)
          .first();
      } else {
        result = await env.DB.prepare(`SELECT * FROM ${collection.table} WHERE id = ?`)
          .bind(numericId)
          .first();
      }
      if (!result) return json({ error: 'Not found.' }, 404);

      if (collection.hasImages && Array.isArray(body.images)) {
        await replaceGalleryImages(env, numericId, body.images);
      }
      return json({ item: hydrate(collection, result) });
    }

    if (method === 'DELETE') {
      // Remove the photos first: D1 does not enforce the cascade by default.
      if (collection.hasImages) {
        await env.DB.prepare('DELETE FROM gallery_images WHERE gallery_id = ?')
          .bind(numericId)
          .run();
      }
      const result = await env.DB.prepare(
        `DELETE FROM ${collection.table} WHERE id = ? RETURNING id`
      )
        .bind(numericId)
        .first();
      if (!result) return json({ error: 'Not found.' }, 404);
      return json({ ok: true, deleted: numericId });
    }

    return json({ error: 'Method not allowed.' }, 405);
  } catch (err) {
    if (err instanceof ValidationError) return json({ error: err.message }, 400);
    if (err instanceof SyntaxError) return json({ error: 'Invalid JSON.' }, 400);
    // The database refuses two documents with the same reference. Say so in
    // words, rather than letting a constraint message reach the screen.
    if (String(err && err.message).includes('UNIQUE constraint failed: documents.ref')) {
      return json({ error: 'Another document already has that reference. Give this one its own.' }, 409);
    }
    console.error('api error', err);
    return json({ error: 'Something went wrong saving that.' }, 500);
  }
}
