'use client';

import { useState } from 'react';
import { formatMinorForDisplay } from '@fenwick/shared/money';
import type { PublicInvoice } from '@/lib/invoice';

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:4000';

type Method = 'CARD' | 'WALLET' | 'ACH';

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
 * Apple Pay and Google Pay both call the API as WALLET (one PaymentMethod
 * value covers both at the domain level) and, like the card form below, are
 * illustrative: real wallet buttons need the Apple Pay JS / Google Pay JS
 * SDKs, domain verification with Apple, and a registered Google Pay merchant
 * ID — none of which exist yet, independent of Numbers Gateway (DEP-01).
 */
function availableMethods(invoice: PublicInvoice): Array<{ key: Method; label: string }> {
  const methods: Array<{ key: Method; label: string }> = [];
  if (invoice.enabledMethods.card) methods.push({ key: 'CARD', label: 'Credit or debit card' });
  if (invoice.enabledMethods.applePay) methods.push({ key: 'WALLET', label: 'Apple Pay' });
  if (invoice.enabledMethods.googlePay && !invoice.enabledMethods.applePay) {
    // Only one WALLET button is meaningful — Apple Pay's label wins if both
    // are on, since the API cannot distinguish which wallet was actually used.
    methods.push({ key: 'WALLET', label: 'Google Pay' });
  }
  if (invoice.enabledMethods.ach) methods.push({ key: 'ACH', label: 'Bank transfer (ACH)' });
  return methods;
}

export function PaymentFlow({ invoice, token }: { invoice: PublicInvoice; token: string }) {
  const [step, setStep] = useState<Step>({ kind: 'select' });
  const [method, setMethod] = useState<Method | null>(null);
  const methods = availableMethods(invoice);

  const feeApplies = method === 'CARD' || method === 'WALLET';
  const quotedTotal = feeApplies
    ? invoice.subtotalMinor + invoice.taxMinor + Math.round(
        (invoice.subtotalMinor + invoice.taxMinor) * (invoice.cardFeeRateBp / 10_000),
      )
    : invoice.balanceMinor;

  async function submitPayment(chosenMethod: Method) {
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
    return (
      <div className="mt-6">
        {/* Illustrative only — nothing entered here is sent anywhere.
            FakeGateway resolves purely from the amount (TDD-001 §10.1), and
            Numbers Gateway's hosted-field question (DEP-01) is unresolved,
            so this cannot be a real capture form yet. */}
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
        <button
          type="button"
          onClick={() => submitPayment('CARD')}
          className="mt-4 w-full rounded-md bg-brand px-4 py-2.5 text-sm font-medium text-brand-foreground"
        >
          Pay {formatMinorForDisplay(quotedTotal, invoice.currency as 'USD')}
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
          key={m.key}
          type="button"
          onClick={() => (m.key === 'CARD' ? setStep({ kind: 'card-details' }) : submitPayment(m.key))}
          className="w-full rounded-md border border-border bg-surface px-4 py-2.5 text-left text-sm font-medium text-ink-strong hover:bg-surface-muted"
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}
