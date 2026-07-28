import Link from 'next/link';
import { BrandTheme } from '@/components/brand-theme';
import { ApiError, getZohoStatus, listBrands, type Brand } from '@/lib/api';
import { backfillZohoAction } from './actions';

export const dynamic = 'force-dynamic';

const FALLBACK_THEME_COLOUR = '#16261F';

const ERROR_MESSAGES: Record<string, string> = {
  missing_brand: 'No brand was selected.',
  connect_failed: 'Could not reach the API to start the Zoho connection.',
  invalid_or_expired_state: 'That connection link expired — start again.',
  no_organizations: 'That Zoho account has no organizations in Zoho Books to connect.',
  unknown_brand: 'This brand could not be resolved.',
};

export default async function ZohoSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ brandId?: string; connected?: string; error?: string; backfilled?: string }>;
}) {
  const params = await searchParams;

  let brands: Brand[] = [];
  let brandsError: string | null = null;
  try {
    brands = await listBrands();
  } catch (cause) {
    brandsError = cause instanceof ApiError ? cause.message : String(cause);
  }

  const activeBrand = brands.find((b) => b.id === params.brandId) ?? brands[0] ?? null;

  let statusError: string | null = null;
  let status = { connected: false, organizationName: null as string | null, lastSyncAt: null as string | null, health: null as string | null };
  if (activeBrand) {
    try {
      status = await getZohoStatus(activeBrand.id);
    } catch (cause) {
      statusError = cause instanceof ApiError ? cause.message : String(cause);
    }
  }

  const errorMessage = params.error ? (ERROR_MESSAGES[params.error] ?? params.error) : null;

  const backfilled = params.backfilled?.split(',').map(Number);
  const backfillMessage =
    backfilled && backfilled.length === 3
      ? backfilled.every((n) => n === 0)
        ? 'Nothing to queue — everything is already synced.'
        : `Queued ${backfilled[0]} customer(s), ${backfilled[1]} invoice(s), ${backfilled[2]} payment(s).`
      : null;

  return (
    <BrandTheme brandColour={activeBrand?.themeColor ?? FALLBACK_THEME_COLOUR}>
      <main className="mx-auto max-w-2xl px-6 py-12">
        <header className="mb-8">
          <p className="text-sm uppercase tracking-widest text-ink-subtle">
            {activeBrand ? activeBrand.displayName : 'Fenwick Holdings Inc.'}
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-ink-strong">Zoho Books</h1>
          <p className="mt-2 text-ink-muted">
            FR-ZHO-001. Pushes customers, invoices and payments to Zoho Books as they happen —
            reading changes back from Zoho is not built yet.
          </p>
        </header>

        {brandsError ? (
          <div className="rounded-md bg-danger-surface p-4 text-sm text-danger">
            Could not load brands: {brandsError}
          </div>
        ) : brands.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-6 text-sm text-ink-muted">
            No brands exist yet.
          </div>
        ) : (
          <>
            {brands.length > 1 && (
              <nav className="mb-6 flex flex-wrap gap-2" aria-label="Switch brand">
                {brands.map((b) => (
                  <Link
                    key={b.id}
                    href={`/settings/zoho?brandId=${b.id}`}
                    className={`rounded-full px-3 py-1 text-sm font-medium ${
                      activeBrand?.id === b.id
                        ? 'bg-ink-strong text-white'
                        : 'bg-surface-muted text-ink-muted hover:text-ink-strong'
                    }`}
                  >
                    {b.displayName}
                  </Link>
                ))}
              </nav>
            )}

            {params.connected && (
              <div className="mb-4 rounded-md bg-success-surface p-3 text-sm text-success">
                Connected.
              </div>
            )}
            {backfillMessage && (
              <div className="mb-4 rounded-md bg-success-surface p-3 text-sm text-success">
                {backfillMessage}
              </div>
            )}
            {errorMessage && (
              <div className="mb-4 rounded-md bg-danger-surface p-3 text-sm text-danger">
                {errorMessage}
              </div>
            )}

            {statusError ? (
              <div className="rounded-md bg-danger-surface p-4 text-sm text-danger">
                Could not load connection status: {statusError}
              </div>
            ) : (
              activeBrand && (
                <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="block text-sm font-medium text-ink-strong">
                        {status.connected ? 'Connected' : 'Not connected'}
                      </span>
                      {status.connected && status.organizationName && (
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          Organization: {status.organizationName}
                        </span>
                      )}
                      {status.connected && status.lastSyncAt && (
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          Last sync: {new Date(status.lastSyncAt).toLocaleString()}
                        </span>
                      )}
                      {status.health && (
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          Health: {status.health}
                        </span>
                      )}
                    </div>
                    <span
                      className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                        status.connected ? 'bg-success' : 'bg-ink-subtle'
                      }`}
                      aria-hidden
                    />
                  </div>

                  <div className="mt-4 flex flex-wrap gap-3">
                    <a
                      href={`/settings/zoho/connect?brandId=${activeBrand.id}`}
                      className="inline-block rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground"
                    >
                      {status.connected ? 'Reconnect Zoho' : 'Connect Zoho'}
                    </a>
                    {status.connected && (
                      <form action={backfillZohoAction}>
                        <input type="hidden" name="brandId" value={activeBrand.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-border px-4 py-2 text-sm font-medium text-ink-strong hover:bg-surface-muted"
                        >
                          Sync existing records
                        </button>
                      </form>
                    )}
                  </div>
                  <p className="mt-3 text-xs text-ink-muted">
                    {status.connected
                      ? 'Sync existing records queues every customer, invoice and payment already in the database that has not been pushed yet — not just new ones going forward.'
                      : "Connecting opens Zoho's own sign-in and consent screen — completing it needs your real Zoho account."}
                  </p>
                </div>
              )
            )}
          </>
        )}
      </main>
    </BrandTheme>
  );
}
