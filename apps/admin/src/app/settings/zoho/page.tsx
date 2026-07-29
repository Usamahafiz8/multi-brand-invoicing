import Link from 'next/link';
import { BrandTheme } from '@/components/brand-theme';
import { ApiError, getZohoActivity, getZohoStatus, listBrands, type Brand, type ZohoActivityEntry } from '@/lib/api';
import { ZohoLivePanel } from './live-panel';

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
  searchParams: Promise<{ brandId?: string; connected?: string; error?: string }>;
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
  let status = {
    connected: false,
    organizationName: null as string | null,
    lastSyncAt: null as string | null,
    lastPulledAt: null as string | null,
    health: null as string | null,
  };
  let activity: ZohoActivityEntry[] = [];
  if (activeBrand) {
    try {
      status = await getZohoStatus(activeBrand.id);
    } catch (cause) {
      statusError = cause instanceof ApiError ? cause.message : String(cause);
    }
    try {
      activity = await getZohoActivity(activeBrand.id);
    } catch {
      // Not shown as a page-level error — the live panel handles its own
      // loading, and the status card above already reports the connection
      // itself accurately either way.
    }
  }

  const errorMessage = params.error ? (ERROR_MESSAGES[params.error] ?? params.error) : null;

  return (
    <BrandTheme brandColour={activeBrand?.themeColor ?? FALLBACK_THEME_COLOUR}>
      <main className="mx-auto max-w-2xl px-6 py-12">
        <header className="mb-8">
          <p className="text-sm uppercase tracking-widest text-ink-subtle">
            {activeBrand ? activeBrand.displayName : 'Fenwick Holdings Inc.'}
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-ink-strong">Zoho Books</h1>
          <p className="mt-2 text-ink-muted">
            FR-ZHO-001/030. Pushes customers, invoices and payments to Zoho Books as they happen,
            and pulls them back automatically every 15 minutes — Zoho is treated as authoritative
            for anything pulled.
          </p>
        </header>

        {brandsError ? (
          <div className="rounded-md bg-danger-surface p-4 text-sm text-danger">
            Could not load brands: {brandsError}
          </div>
        ) : brands.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface p-8 text-center">
            <p className="text-sm text-ink-muted">No brands exist yet.</p>
            <Link
              href="/brands/new"
              className="mt-4 inline-block rounded-md bg-brand px-4 py-2 text-sm font-medium text-brand-foreground"
            >
              Create your first brand
            </Link>
          </div>
        ) : (
          <>
            {params.connected && (
              <div className="mb-4 rounded-md bg-success-surface p-3 text-sm text-success">
                Connected.
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
                          Last push: {new Date(status.lastSyncAt).toLocaleString()}
                        </span>
                      )}
                      {status.connected && (
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          Last pull:{' '}
                          {status.lastPulledAt ? new Date(status.lastPulledAt).toLocaleString() : 'Never yet'}
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

                  <div className="mt-4">
                    <ZohoLivePanel
                      brandId={activeBrand.id}
                      connected={status.connected}
                      connectHref={`/settings/zoho/connect?brandId=${activeBrand.id}`}
                      initial={activity}
                    />
                  </div>
                </div>
              )
            )}
          </>
        )}
      </main>
    </BrandTheme>
  );
}
