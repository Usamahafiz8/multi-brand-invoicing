/**
 * The bare origin carries no invoice and therefore names no brand. A customer
 * only ever arrives here by trimming a URL, and they should learn nothing from
 * doing so.
 */
// The CSP nonce is per response, so a prerendered copy of this page would carry
// a stale one and have its own scripts blocked. Nothing here is worth caching.
export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <main className="mx-auto flex min-h-full max-w-md flex-col justify-center px-6 py-16">
      <div className="rounded-lg border border-border bg-surface p-8 text-center shadow-sm">
        <h1 className="text-lg font-medium text-ink-strong">Nothing to pay here</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Open the payment link from your invoice email to view and pay an invoice.
        </p>
      </div>
    </main>
  );
}
