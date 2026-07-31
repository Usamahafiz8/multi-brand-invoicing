import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Receipt } from 'lucide-react';
import { requireUser } from '@/lib/auth';
import { listBrands, type Brand } from '@/lib/api';
import { OnboardingForm } from './onboarding-form';

export const metadata: Metadata = { title: 'Create your first brand — Fenwick Invoicing' };
export const dynamic = 'force-dynamic';

/**
 * First-run. Deliberately outside the (app) group and so without the admin
 * shell: the sidebar is a brand switcher and a set of brand-scoped links, none
 * of which mean anything until the brand this screen creates exists.
 *
 * It is still authenticated — requireUser does here exactly what (app)/layout
 * does there, and middleware gates the route either way.
 */
export default async function OnboardingPage() {
  await requireUser();

  // Reachable directly by URL, so it has to check rather than assume. A
  // merchant that already has brands is not onboarding.
  let brands: Brand[] = [];
  try {
    brands = await listBrands();
  } catch {
    // A role without BRANDS READ cannot answer the question and cannot create
    // a brand either (FRS-001 §3.3 grants both to Owner and Merchant Admin
    // only). Let the form render; the API refuses the submit with a 403.
  }
  if (brands.length > 0) redirect('/');

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6 py-12">
      <div className="w-full max-w-md">
        <div className="rounded-xl border border-border bg-surface p-8 shadow-md">
          <div className="mb-6 flex flex-col items-center text-center">
            <span className="mb-4 flex h-11 w-11 items-center justify-center rounded-lg bg-ink">
              <Receipt className="h-5 w-5 text-ink-inverse" aria-hidden />
            </span>
            <h1 className="text-xl font-semibold tracking-tight text-ink-strong">
              Create your first brand
            </h1>
            <p className="mt-1.5 text-sm text-ink-muted">
              Set up your brand profile to start creating professional invoices.
            </p>
          </div>

          <OnboardingForm />
        </div>

        <p className="mt-5 text-center text-xs text-ink-subtle">
          You can change any of this later in Brand Setup.
        </p>
      </div>
    </main>
  );
}
