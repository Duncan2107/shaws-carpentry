/**
 * Cloudflare Access verification for /admin and /api.
 *
 * Access sits in front of those routes and, once someone has logged in,
 * forwards their identity in a signed Cf-Access-Jwt-Assertion header.
 *
 * We verify that token's signature ourselves rather than trusting the header.
 * The header alone is not proof: the Worker is also reachable on its
 * *.workers.dev hostname, which the Access policy does not cover, so anyone
 * could otherwise set the header by hand and walk straight in.
 */

const CERTS_TTL_MS = 60 * 60 * 1000; // Access rotates keys infrequently.
let certsCache = { keys: null, fetchedAt: 0, teamDomain: null };

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
}

async function getSigningKeys(teamDomain) {
  const fresh =
    certsCache.keys &&
    certsCache.teamDomain === teamDomain &&
    Date.now() - certsCache.fetchedAt < CERTS_TTL_MS;
  if (fresh) return certsCache.keys;

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`could not fetch Access certs: ${response.status}`);
  const { keys } = await response.json();
  certsCache = { keys, fetchedAt: Date.now(), teamDomain };
  return keys;
}

/**
 * Returns the caller's email if the token is valid, otherwise null.
 */
export async function verifyAccessToken(token, teamDomain, audience) {
  if (!token || !teamDomain || !audience) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerSegment, payloadSegment, signatureSegment] = parts;

  let header;
  let payload;
  try {
    header = decodeJson(headerSegment);
    payload = decodeJson(payloadSegment);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256') return null;

  const keys = await getSigningKeys(teamDomain);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signed = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    base64UrlDecode(signatureSegment),
    signed
  );
  if (!valid) return null;

  // The audience ties the token to this specific Access application, so a
  // token issued for some other app on the same account will not work here.
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) return null;

  if (payload.iss !== `https://${teamDomain}`) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) return null;
  if (typeof payload.nbf === 'number' && payload.nbf > now) return null;

  return payload.email || payload.sub || 'unknown';
}

/**
 * Gate for protected routes.
 *
 * Returns { ok: true, email } when the caller is allowed through, or
 * { ok: false, response } with the error to send back.
 */
export async function requireAdmin(request, env) {
  // Local development only. ADMIN_DEV_BYPASS lives in .dev.vars, which is
  // git-ignored and never uploaded, so it cannot be set on the deployed
  // Worker.
  if (env.ADMIN_DEV_BYPASS === 'true') {
    return { ok: true, email: 'local-dev@localhost' };
  }

  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;

  if (!teamDomain || !audience) {
    return {
      ok: false,
      response: json(
        {
          error:
            'Admin is not configured yet. Set ACCESS_TEAM_DOMAIN and ACCESS_AUD, then redeploy.',
        },
        503
      ),
    };
  }

  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    cookieValue(request.headers.get('Cookie'), 'CF_Authorization');

  const email = await verifyAccessToken(token, teamDomain, audience);
  if (!email) {
    return { ok: false, response: json({ error: 'Not signed in.' }, 403) };
  }

  return { ok: true, email };
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
