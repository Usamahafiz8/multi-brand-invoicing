import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { AdminShell } from '@/components/admin-shell';
import { getCurrentUser, listBrands, type Brand, type CurrentUser } from '@/lib/api';
import { LOGIN_PATH } from '@/lib/session';

/**
 * The authenticated half of the app. Everything below this layout is behind a
 * session.
 *
 * Middleware turns away requests carrying no cookie at all, but a cookie is not
 * a session — it can be expired, revoked, or point at a suspended user. This is
 * where that is settled, against the API, on every render. Middleware is the
 * cheap filter; this is the actual gate.
 */
export default async function AuthenticatedLayout({ children }: { children: React.ReactNode }) {
  let user: CurrentUser;
  try {
    user = await getCurrentUser();
  } catch {
    // Any failure to establish who this is means no access. The cookie is left
    // for /login to clear, so a momentary API outage does not silently sign
    // everyone out of a session that is still perfectly valid.
    redirect(`${LOGIN_PATH}?expired=1`);
  }

  let brands: Brand[] = [];
  try {
    brands = await listBrands();
  } catch {
    // The shell renders with no brands rather than crashing the whole app —
    // every page already has its own "API not reachable" handling for the
    // data it actually needs. A user whose role cannot list brands (FRS-001
    // §3.3 grants BRANDS READ to Owner and Merchant Admin only) lands here too.
  }

  return (
    <Suspense fallback={null}>
      <AdminShell brands={brands} user={user}>
        {children}
      </AdminShell>
    </Suspense>
  );
}
