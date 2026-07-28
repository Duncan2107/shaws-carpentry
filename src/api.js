/**
 * Admin API behind Cloudflare Access.
 *
 * Every route here is gated by requireAdmin() in the router before it is
 * reached, so these handlers assume the caller is already authenticated.
 */

import { json } from './auth.js';

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
      featured: { type: 'bool', default: 0 },
      sort_order: { type: 'int', default: 0 },
      published: { type: 'bool', default: 1 },
    },
  },
  gallery: {
    table: 'gallery',
    fields: {
      caption: { type: 'text', required: true, max: 120 },
      image_key: { type: 'text', required: true, max: 300 },
      image_alt: { type: 'text', max: 300, default: '' },
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
};

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
]);

class ValidationError extends Error {}

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

function buildRow(collection, body, { partial }) {
  const row = {};
  for (const [name, spec] of Object.entries(collection.fields)) {
    const value = coerce(name, spec, body[name], { partial });
    if (value !== undefined) row[name] = value;
  }
  if (partial && Object.keys(row).length === 0) {
    throw new ValidationError('Nothing to update.');
  }
  return row;
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
    gallery: gallery.results,
    testimonials: testimonials.results,
    settings: setting,
  };
}

/** Photos available to pick from, so the admin can attach one to an item. */
async function listPhotos(env) {
  const seen = new Set();

  const rows = await env.DB.batch([
    env.DB.prepare('SELECT DISTINCT image_key FROM services WHERE image_key IS NOT NULL'),
    env.DB.prepare('SELECT DISTINCT image_key FROM gallery WHERE image_key IS NOT NULL'),
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
  const [, resource, id] = segments;
  const method = request.method.toUpperCase();

  try {
    if (!resource || (resource === 'content' && method === 'GET')) {
      return json(await listAll(env));
    }

    if (resource === 'photos' && method === 'GET') {
      return json({ photos: await listPhotos(env) });
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

    if (method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT * FROM ${collection.table} ORDER BY sort_order, id`
      ).all();
      return json({ items: results });
    }

    if (method === 'POST') {
      const row = buildRow(collection, await request.json(), { partial: false });
      const columns = Object.keys(row);
      const placeholders = columns.map(() => '?').join(', ');
      const result = await env.DB.prepare(
        `INSERT INTO ${collection.table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`
      )
        .bind(...columns.map((c) => row[c]))
        .first();
      return json({ item: result }, 201);
    }

    const numericId = Math.trunc(Number(id));
    if (!Number.isFinite(numericId) || numericId <= 0) {
      return json({ error: 'Missing or invalid id.' }, 400);
    }

    if (method === 'PUT' || method === 'PATCH') {
      const row = buildRow(collection, await request.json(), { partial: true });
      const assignments = Object.keys(row)
        .map((c) => `${c} = ?`)
        .join(', ');
      const result = await env.DB.prepare(
        `UPDATE ${collection.table} SET ${assignments}, updated_at = datetime('now')
          WHERE id = ? RETURNING *`
      )
        .bind(...Object.keys(row).map((c) => row[c]), numericId)
        .first();
      if (!result) return json({ error: 'Not found.' }, 404);
      return json({ item: result });
    }

    if (method === 'DELETE') {
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
    console.error('api error', err);
    return json({ error: 'Something went wrong saving that.' }, 500);
  }
}
