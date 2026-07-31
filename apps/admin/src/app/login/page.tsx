import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/api';
import { readSessionToken, safeReturnPath } from '@/lib/session';
import { LoginForm } from './login-form';

export const metadata: Metadata = { title: 'Sign in — Fenwick Invoicing' };
export const dynamic = 'force-dynamic';

/**
 * The one route outside the (app) group, so it renders without the admin shell —
 * a sidebar full of links you cannot follow is not a sign-in page.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; expired?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnPath(params.next);

  // Someone already signed in has no business here. Verified against the API
  // rather than trusted from the cookie's presence — a stale cookie would
  // otherwise bounce them into the app and straight back out again.
  if (await readSessionToken()) {
    const stillValid = await getCurrentUser().then(
      () => true,
      () => false,
    );
    if (stillValid) redirect(returnTo);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-black px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Fenwick Invoicing</h1>
          <p className="mt-1.5 text-sm text-neutral-400">Sign in to continue.</p>
        </div>

        <div className="rounded-xl bg-white p-8 shadow-lg">
          {params.expired && (
            <p
              role="status"
              className="mb-5 rounded-md border border-neutral-300 bg-neutral-100 px-3 py-2.5 text-sm text-black"
            >
              Your session ended. Sign in again to continue.
            </p>
          )}

          <LoginForm returnTo={returnTo} />
        </div>

        <p className="mt-6 text-center text-xs text-neutral-500">
          Fenwick Holdings Inc. — authorised users only.
        </p>
      </div>
    </main>
  );
}
