import { redirect } from 'next/navigation';
import { getCurrentUser, type CurrentUser } from './api';
import { LOGIN_PATH } from './session';

/**
 * Establishes who is asking, or sends them to sign in.
 *
 * Middleware only checks that a cookie exists — it runs on the edge runtime
 * with no database and cannot tell a live session from a revoked one. This is
 * the check that settles it, and it is shared so that a screen rendering
 * outside the (app) group (onboarding) is gated exactly as tightly as one
 * inside it. Neither is the real enforcement: that is the API's guard.
 */
export async function requireUser(): Promise<CurrentUser> {
  try {
    return await getCurrentUser();
  } catch {
    // The cookie is deliberately left in place for /login to deal with, so a
    // momentary API outage does not sign everyone out of valid sessions.
    redirect(`${LOGIN_PATH}?expired=1`);
  }
}
