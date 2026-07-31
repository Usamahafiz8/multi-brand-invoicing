'use client';

import { useCallback, useState } from 'react';
import { formatMinorForDisplay } from '@fenwick/shared/money';
import type { PublicInvoice } from '@/lib/invoice';
import { HostedCardFields, type CardNonce } from './hosted-card-fields';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

type Method = 'CARD' | 'WALLET' | 'ACH';

/**
 * The library rejects with a plain object carrying `fieldErrors` as often as
 * with an Error, so both shapes are unwrapped into something a customer can act
 * on rather than surfacing "[object Object]".
 */
function readTokenizationError(error: unknown): string {
  const fieldErrors = (error as { fieldErrors?: unknown } | null)?.fieldErrors;
  if (Array.isArray(fieldErrors) && fieldErrors.length > 0) {
    return `Please check the ${fieldErrors.join(', ')} field${fieldErrors.length > 1 ? 's' : ''}.`;
  }
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Please check the card details and try again.';
}

/** Mirrors paymentSourceSchema on the API. Never carries raw card data. */
interface PaymentSourceBody {
  kind: 'NONCE' | 'WALLET' | 'STORED';
  token: string;
  walletProvider?: 'GOOGLE_PAY' | 'APPLE_PAY';
  expiryMonth?: number;
  expiryYear?: number;
  avsZip?: string;
}

type Step =
  | { kind: 'select' }
  | { kind: 'card-details' }
  | { kind: 'processing' }
  | { kind: 'success' }
  | { kind: 'pending' }
  | { kind: 'failure'; reason: string | null }
  | { kind: 'error'; message: string };

/**
 * FR-PAY-005: the method list is built from what this brand actually has
 * enabled (invoice.enabledMethods), not hardcoded — PaymentsService enforces
 * the same list server-side regardless of what renders here.
 *
 * Apple Pay and Google Pay are separate toggles because they are separate
 * merchant registrations in the real world, so each gets its own button. Both
 * submit as WALLET: that is the single value the domain, the database enum and
 * PaymentsService.methodEnabled all recognise, and a WALLET attempt is
 * permitted when *either* wallet is enabled. Nothing downstream needs to know
 * which sheet the customer tapped.
 *
 * Like the card form below, both are illustrative: real wallet buttons need the
 * Apple Pay JS / Google Pay JS SDKs, domain verification with Apple, and a
 * registered Google Pay merchant ID — none of which exist yet, independent of
 * Numbers Gateway (DEP-01).
 */
interface MethodOption {
  /** Stable per-button identity — two entries can share one `method`. */
  readonly id: string;
  readonly method: Method;
  readonly label: string;
}

function availableMethods(invoice: PublicInvoice): MethodOption[] {
  const methods: MethodOption[] = [];
  if (invoice.enabledMethods.card) {
    methods.push({ id: 'card', method: 'CARD', label: 'Credit or debit card' });
  }
  if (invoice.enabledMethods.applePay) {
    methods.push({ id: 'apple-pay', method: 'WALLET', label: 'Apple Pay' });
  }
  if (invoice.enabledMethods.googlePay) {
    methods.push({ id: 'google-pay', method: 'WALLET', label: 'Google Pay' });
  }
  if (invoice.enabledMethods.ach) {
    methods.push({ id: 'ach', method: 'ACH', label: 'Bank transfer (ACH)' });
  }
  return methods;
}

export function PaymentFlow({ invoice, token }: { invoice: PublicInvoice; token: string }) {
  const [step, setStep] = useState<Step>({ kind: 'select' });
  const [method, setMethod] = useState<Method | null>(null);
  const methods = availableMethods(invoice);

  // Set by <HostedCardFields> once the gateway's iframes are live; null while
  // they are still loading, or if the library failed outright.
  const [getCardNonce, setGetCardNonce] = useState<(() => Promise<CardNonce>) | null>(null);
  /** Validation feedback from the tokenization step, shown above the button. */
  const [fieldMessage, setFieldMessage] = useState<string | null>(null);
  /** True while the gateway mints a nonce — the fields must stay mounted. */
  const [tokenizing, setTokenizing] = useState(false);
  // A state setter would treat a bare function as a lazy initialiser, so the
  // callback has to be stored wrapped.
  const handleFieldsReady = useCallback((getNonce: (() => Promise<CardNonce>) | null) => {
    setGetCardNonce(() => getNonce);
  }, []);

  const feeApplies = method === 'CARD' || method === 'WALLET';
  const quotedTotal = feeApplies
    ? invoice.subtotalMinor + invoice.taxMinor + Math.round(
        (invoice.subtotalMinor + invoice.taxMinor) * (invoice.cardFeeRateBp / 10_000),
      )
    : invoice.balanceMinor;

  /**
   * Card payment in two steps: mint a nonce from the gateway's iframed fields,
   * then charge against that nonce. The nonce is the only thing that crosses
   * back into this app — the card number stays inside the gateway's document.
   *
   * With no hosted tokenization configured (FakeGateway) there is nothing to
   * tokenize, so this charges directly.
   */
  async function payByCard(): Promise<void> {
    if (!invoice.tokenization) {
      await submitPayment('CARD');
      return;
    }

    if (!getCardNonce) {
      setFieldMessage('The secure card form is not ready yet.');
      return;
    }

    // Deliberately NOT switching to the processing step yet. Doing so unmounts
    // the hosted fields, which destroys the gateway's iframe out from under the
    // library — it then rejects with "iframe not found" and no card can ever be
    // tokenized. The step only changes once the nonce is safely in hand.
    setTokenizing(true);
    setFieldMessage(null);

    let card: CardNonce;
    try {
      card = await getCardNonce();
    } catch (error) {
      // A rejection here is almost always field validation, so keep the
      // customer on the form with the reason rather than sending them to a
      // dead end.
      setFieldMessage(readTokenizationError(error));
      return;
    } finally {
      setTokenizing(false);
    }

    await submitPayment('CARD', {
      kind: 'NONCE',
      token: card.nonce,
      ...(card.expiryMonth === undefined ? {} : { expiryMonth: card.expiryMonth }),
      ...(card.expiryYear === undefined ? {} : { expiryYear: card.expiryYear }),
      ...(card.avsZip === undefined ? {} : { avsZip: card.avsZip }),
    });
  }

  async function submitPayment(chosenMethod: Method, source?: PaymentSourceBody) {
    setMethod(chosenMethod);
    setStep({ kind: 'processing' });
    try {
      const response = await fetch(`${API_URL}/public/invoices/${token}/payment-intents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: chosenMethod,
          // Client-generated: a double click collapses to one charge
          // (TDD-001 §8.3), since the server derives its idempotency key
          // from this value.
          attemptNonce: crypto.randomUUID(),
          ...(source ? { source } : {}),
        }),
      });
      const body = (await response.json()) as {
        gatewayStatus?: string;
        declineReason?: string | null;
        message?: string;
      };
      if (!response.ok) {
        setStep({ kind: 'error', message: body.message ?? 'Something went wrong.' });
        return;
      }
      if (body.gatewayStatus === 'SUCCEEDED') setStep({ kind: 'success' });
      else if (body.gatewayStatus === 'FAILED') {
        setStep({ kind: 'failure', reason: body.declineReason ?? null });
      } else setStep({ kind: 'pending' });
    } catch (error) {
      setStep({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The network request failed.',
      });
    }
  }

  if (step.kind === 'success') {
    return (
      <div className="mt-6 text-center">
        <p className="text-sm font-medium text-success">Payment successful</p>
        <p className="mt-1 text-xs text-ink-muted">A receipt has been sent to you.</p>
      </div>
    );
  }

  if (step.kind === 'pending') {
    return (
      <div className="mt-6 text-center">
        <p className="text-sm font-medium text-ink-strong">Payment pending</p>
        <p className="mt-1 text-xs text-ink-muted">
          Your bank transfer is being verified. This usually takes 1–2 business days.
        </p>
      </div>
    );
  }

  if (step.kind === 'failure') {
    return (
      <div className="mt-6">
        <p className="text-center text-sm font-medium text-danger">Payment couldn&rsquo;t be processed</p>
        {step.reason && <p className="mt-1 text-center text-xs text-ink-muted">{step.reason}</p>}
        <button
          type="button"
          onClick={() => setStep({ kind: 'select' })}
          className="mt-4 w-full rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground"
        >
          Try again
        </button>
      </div>
    );
  }

  if (step.kind === 'error') {
    return (
      <div className="mt-6 text-center">
        <p className="text-sm font-medium text-danger">We couldn&rsquo;t reach the payment service</p>
        <p className="mt-1 text-xs text-ink-muted">{step.message}</p>
        <button
          type="button"
          onClick={() => setStep({ kind: 'select' })}
          className="mt-4 rounded-md border border-border bg-surface px-4 py-2 text-sm font-medium text-ink-strong"
        >
          Back
        </button>
      </div>
    );
  }

  if (step.kind === 'processing') {
    return (
      <div className="mt-6 text-center">
        <p className="text-sm font-medium text-ink-strong">Processing your payment…</p>
      </div>
    );
  }

  if (step.kind === 'card-details') {
    const tokenization = invoice.tokenization;

    return (
      <div className="mt-6">
        {tokenization ? (
          <HostedCardFields
            libraryUrl={tokenization.libraryUrl}
            publicKey={tokenization.publicKey}
            onReady={handleFieldsReady}
          />
        ) : (
          <>
            {/* No hosted tokenization means FakeGateway, which resolves purely
                from the amount (TDD-001 §10.1) and never looks at an
                instrument. These inputs are disabled on purpose: a working
                card field that this app owned would put it in PCI SAQ D. */}
            <p className="mb-3 text-xs text-ink-subtle">
              Demo only — no card details are transmitted or stored.
            </p>
            <div className="space-y-3">
              <input
                disabled
                placeholder="Card number"
                className="w-full rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-ink-subtle"
              />
              <div className="grid grid-cols-2 gap-3">
                <input
                  disabled
                  placeholder="MM / YY"
                  className="w-full rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-ink-subtle"
                />
                <input
                  disabled
                  placeholder="CVC"
                  className="w-full rounded-md border border-border bg-surface-muted px-3 py-2 text-sm text-ink-subtle"
                />
              </div>
            </div>
          </>
        )}
        {fieldMessage && (
          <p className="mt-3 text-sm text-danger" role="alert">
            {fieldMessage}
          </p>
        )}
        <button
          type="button"
          // Disabled until the gateway's fields can actually mint a nonce, so
          // the button cannot fail on click for a reason the customer can see.
          disabled={(Boolean(tokenization) && !getCardNonce) || tokenizing}
          onClick={() => void payByCard()}
          className="mt-4 w-full rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground disabled:opacity-60"
        >
          {tokenizing
            ? 'Checking your card…'
            : `Pay ${formatMinorForDisplay(quotedTotal, invoice.currency as 'USD')}`}
        </button>
        <button
          type="button"
          onClick={() => setStep({ kind: 'select' })}
          className="mt-2 w-full text-center text-xs text-ink-muted"
        >
          Back
        </button>
      </div>
    );
  }

  if (methods.length === 0) {
    return (
      <div className="mt-6 rounded-md bg-danger-surface p-4 text-center text-sm text-danger">
        This brand has no payment method enabled right now. Please contact them directly.
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-2">
      {methods.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() =>
            m.method === 'CARD' ? setStep({ kind: 'card-details' }) : submitPayment(m.method)
          }
          className="w-full rounded-md border border-border bg-surface px-4 py-2.5 text-left text-sm font-medium text-ink-strong hover:bg-surface-muted"
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
