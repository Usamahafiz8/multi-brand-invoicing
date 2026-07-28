import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The OAuth `state` parameter, self-verifying rather than looked up
 * server-side. Zoho's redirect back to our callback is a fresh,
 * unauthenticated browser request — no session cookie can be relied on to
 * say which brand initiated this, or that this callback was not forged. HMAC
 * signing the brandId (and an issued-at bound to a short window) answers
 * both without a Redis key to manage and expire.
 */
const MAX_AGE_MS = 10 * 60 * 1000; // long enough for a human to click through Zoho's consent screen

interface StatePayload {
  readonly brandId: string;
  readonly iat: number;
}

export function signZohoState(brandId: string, secret: string): string {
  const payload: StatePayload = { brandId, iat: Date.now() };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

/** Null on any failure — forged, expired, or malformed all look identical to
 * the caller, which is what refuses to leak which case occurred. */
export function verifyZohoState(state: string, secret: string): { brandId: string } | null {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) return null;

  const expected = createHmac('sha256', secret).update(encoded).digest('base64url');
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) return null;

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload;
  } catch {
    return null;
  }
  if (typeof payload.brandId !== 'string' || typeof payload.iat !== 'number') return null;
  if (Date.now() - payload.iat > MAX_AGE_MS) return null;

  return { brandId: payload.brandId };
}
