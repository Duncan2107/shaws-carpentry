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
      const body = await request.json();
      const row = buildRow(collection, body, { partial: false });
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
      return json({ item: result }, 201);
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
      return json({ item: result });
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
    console.error('api error', err);
    return json({ error: 'Something went wrong saving that.' }, 500);
  }
}
