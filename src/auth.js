/**
 * Sign-in for /admin and /api.
 *
 * Two ways in, checked in this order:
 *
 *   1. A username and password, kept in the admin_users table. Signing in
 *      sets a signed session cookie which this Worker issues and verifies
 *      itself. See db/migrations/003-admin-login.sql.
 *   2. A Cloudflare Access token, if ACCESS_TEAM_DOMAIN and ACCESS_AUD are
 *      set. Kept so a site already using Access keeps working.
 *
 * Either way the check happens inside the Worker. That matters: the Worker
 * can be reachable on hostnames an Access policy does not cover, so a gate
 * that lives only in front of it can be walked around. Nothing here trusts a
 * header it has not verified.
 */

const CERTS_TTL_MS = 60 * 60 * 1000; // Access rotates keys infrequently.
let certsCache = { keys: null, fetchedAt: 0, teamDomain: null };

const SESSION_COOKIE = 'admin_session';
const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

// Sign-in is slow on purpose. Ten wrong guesses inside the window and that
// username stops answering until the window passes.
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_MINUTES = 15;

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

/* ------------------------------------------------- username and password */

/**
 * Reads a stored `pbkdf2$sha256$<iterations>$<salt>$<hash>` string.
 *
 * The iteration count is part of the stored value rather than a constant in
 * here, so raising it later is a matter of setting the password again and
 * existing accounts keep working in the meantime.
 */
function parseStoredHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 5) return null;
  if (parts[0] !== 'pbkdf2' || parts[1] !== 'sha256') return null;

  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 2000000) return null;

  try {
    return { iterations, salt: base64UrlDecode(parts[3]), expected: base64UrlDecode(parts[4]) };
  } catch {
    return null;
  }
}

async function deriveKeyBits(password, salt, iterations, lengthBits) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    lengthBits
  );
  return new Uint8Array(bits);
}

// Compares in a fixed number of steps, so how long this takes says nothing
// about how much of the value was correct.
function equalBytes(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function checkPassword(password, stored) {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;
  const actual = await deriveKeyBits(
    password,
    parsed.salt,
    parsed.iterations,
    parsed.expected.length * 8
  );
  return equalBytes(actual, parsed.expected);
}

/**
 * The key the session cookie is signed with.
 *
 * Derived from the stored password hash, which means there is no extra secret
 * to set up, and changing someone's password signs every session they had
 * straight out.
 */
async function sessionKey(passwordHash) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`admin-session|${passwordHash}`)
  );
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function findAdminUser(env, username) {
  if (!env.DB || !username) return null;
  return env.DB.prepare(
    'SELECT username, password_hash, display_name FROM admin_users WHERE username = ?'
  )
    .bind(String(username).trim().toLowerCase())
    .first();
}

async function issueSession(user) {
  const payload = {
    u: user.username,
    exp: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS,
  };
  const body = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await sessionKey(user.password_hash),
    new TextEncoder().encode(body)
  );
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Returns the signed-in username, or null.
 *
 * The username inside the cookie decides which account to look up, and that
 * account's key then has to verify the signature. An edited cookie fails at
 * that step.
 */
async function readSession(request, env) {
  const raw = cookieValue(request.headers.get('Cookie'), SESSION_COOKIE);
  if (!raw) return null;

  const [body, signature] = raw.split('.');
  if (!body || !signature) return null;

  let payload;
  try {
    payload = decodeJson(body);
  } catch {
    return null;
  }

  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;

  const user = await findAdminUser(env, payload.u);
  if (!user) return null;

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await sessionKey(user.password_hash),
      base64UrlDecode(signature),
      new TextEncoder().encode(body)
    );
  } catch {
    return null;
  }

  return valid ? user.username : null;
}

function sessionCookie(request, value, maxAgeSeconds) {
  // Secure is left off on plain http so the cookie still works against
  // `wrangler dev` on localhost.
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly;${secure} SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}

async function recentFailures(env, username) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS failures FROM admin_login_attempts
     WHERE username = ? AND at > datetime('now', ?)`
  )
    .bind(username, `-${LOCKOUT_MINUTES} minutes`)
    .first();
  return row ? row.failures : 0;
}

/**
 * POST /api/login with { username, password }.
 *
 * Reachable without a session, for obvious reasons, so it is the one route
 * that has to look after itself.
 */
export async function handleLogin(request, env) {
  if (!env.DB) {
    return json({ error: 'Sign-in is not available: the database is not connected.' }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a username and a password.' }, 400);
  }

  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');

  // The same message for every failure. Saying which half was wrong would
  // confirm whether a username exists.
  const refused = json({ error: 'That username and password did not match.' }, 401);

  if (!username || !password || username.length > 120 || password.length > 300) return refused;

  if ((await recentFailures(env, username)) >= MAX_FAILED_LOGINS) {
    return json(
      { error: `Too many attempts. Wait ${LOCKOUT_MINUTES} minutes and try again.` },
      429
    );
  }

  const user = await findAdminUser(env, username);
  const ok = user ? await checkPassword(password, user.password_hash) : false;

  if (!ok) {
    await env.DB.prepare('INSERT INTO admin_login_attempts (username) VALUES (?)')
      .bind(username)
      .run();
    return refused;
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_login_attempts WHERE username = ?').bind(username),
    env.DB.prepare(
      `DELETE FROM admin_login_attempts WHERE at <= datetime('now', ?)`
    ).bind(`-${LOCKOUT_MINUTES} minutes`),
    env.DB.prepare(`UPDATE admin_users SET last_login_at = datetime('now') WHERE username = ?`).bind(
      username
    ),
  ]);

  const token = await issueSession(user);
  return json(
    { ok: true, name: user.display_name || user.username },
    200,
    { 'Set-Cookie': sessionCookie(request, token, SESSION_MAX_AGE_SECONDS) }
  );
}

/**
 * POST /api/logout. Clears the cookie whether or not one was valid.
 */
export function handleLogout(request) {
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
}

/* ------------------------------------------------------------- the gate */

/**
 * Gate for protected routes.
 *
 * Returns { ok: true, email } when the caller is allowed through, or
 * { ok: false, response } with the error to send back.
 */
export async function requireAdmin(request, env) {
  // Local development only. ADMIN_DEV_BYPASS lives in .dev.vars, which is
  // git-ignored and never uploaded, so it cannot be set on the deployed
  // Worker. Set it to anything else to exercise the real sign-in locally.
  if (env.ADMIN_DEV_BYPASS === 'true') {
    return { ok: true, email: 'local-dev@localhost' };
  }

  const username = await readSession(request, env);
  if (username) return { ok: true, email: username };

  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  if (teamDomain && audience) {
    const token =
      request.headers.get('Cf-Access-Jwt-Assertion') ||
      cookieValue(request.headers.get('Cookie'), 'CF_Authorization');
    const email = await verifyAccessToken(token, teamDomain, audience);
    if (email) return { ok: true, email };
  }

  if (!env.DB) {
    return {
      ok: false,
      response: json({ error: 'Sign-in is not configured for this site yet.' }, 503),
    };
  }

  return { ok: false, response: json({ error: 'Not signed in.' }, 403) };
}

function cookieValue(cookieHeader, name) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}
