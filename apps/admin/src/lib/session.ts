import { cookies } from 'next/headers';

/**
 * The admin app's half of FR-AUTH-001.
 *
 * The API issues the session token; this app stores it in its OWN httpOnly
 * cookie, on its own origin, and replays it upstream from the server on every
 * request. It cannot simply reuse the cookie the API sets: that cookie belongs
 * to the API's origin, and making it readable here would mean SameSite=None,
 * which requires HTTPS and so cannot work in local development at all.
 *
 * The practical consequence is the useful one — the token never reaches the
 * browser. No script on this page can read it, so an XSS bug cannot lift a
 * session out of it.
 */
export const SESSION_COOKIE = 'fenwick_admin_session';

/** Where an unauthenticated request is sent, and the key it comes back on. */
export const LOGIN_PATH = '/login';
export const RETURN_TO_PARAM = 'next';

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function writeSessionToken(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // Set on HTTPS deployments; omitted locally, where http://localhost would
    // otherwise drop the cookie silently and leave sign-in looping.
    secure: process.env.NODE_ENV === 'production',
    expires: expiresAt,
    path: '/',
  });
}

export async function clearSessionToken(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}

/**
 * Keeps an open redirect out of the sign-in flow: only a path on this origin is
 * ever followed, never an absolute URL someone appended to the query string.
 */
export function safeReturnPath(value: string | null | undefined): string {
  if (!value) return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
