import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationError, type CreateIntentInput } from '@fenwick/shared';
import type { Env } from '../../config/env.js';
import {
  StripeGatewayAdapter,
  encode,
  parseSignatureHeader,
  toEventType,
} from './stripe-gateway.adapter.js';

/**
 * Exercised against a stubbed fetch rather than Stripe's test mode: these
 * assertions must hold without keys and without a network, and a live sandbox
 * can only prove something was accepted — not that we sent what we meant to.
 */

const WEBHOOK_SECRET = 'whsec_test_signing_secret';

const ENV_STUB = {
  STRIPE_API_BASE_URL: 'https://api.stripe.com/v1',
  STRIPE_SECRET_KEY: 'sk_test_abc123',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_API_VERSION: '2024-06-20',
} as unknown as Env;

function baseInput(overrides: Partial<CreateIntentInput> = {}): CreateIntentInput {
  return {
    idempotencyKey: 'idem-1',
    invoiceId: 'inv-123',
    brandId: 'brand-1',
    amountMinor: 46_800,
    currency: 'USD',
    method: 'CARD',
    description: 'Invoice INV-000019',
    customer: { email: 'payer@example.com', name: 'Jane Payer' },
    returnUrl: 'https://pay.example.com/i/tok',
    source: { kind: 'NONCE', token: 'pm_card_visa' },
    ...overrides,
  };
}

function succeededIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pi_3ABC',
    object: 'payment_intent',
    status: 'succeeded',
    amount: 46_800,
    amount_received: 46_800,
    currency: 'usd',
    created: 1_785_000_000,
    client_secret: 'pi_3ABC_secret_xyz',
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function respondWith(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    }),
  );
}

/** The body actually sent, decoded back from Stripe's form encoding. */
function sentBody(): URLSearchParams {
  return new URLSearchParams(String(fetchMock.mock.calls[0]?.[1]?.body ?? ''));
}

function sentHeaders(): Record<string, string> {
  return (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('encode', () => {
  it('uses bracket notation for nested objects', () => {
    expect(encode({ metadata: { invoice_id: 'inv-1' } })).toBe('metadata%5Binvoice_id%5D=inv-1');
  });

  it('indexes arrays', () => {
    expect(encode({ payment_method_types: ['card'] })).toBe('payment_method_types%5B0%5D=card');
  });

  it('drops null and undefined rather than sending an empty string', () => {
    // An empty value tells Stripe to CLEAR a field, which is not what an
    // absent one means.
    expect(encode({ a: 1, b: null, c: undefined })).toBe('a=1');
  });

  it('encodes booleans and special characters', () => {
    expect(encode({ confirm: true, description: 'Invoice #19 & co' })).toBe(
      'confirm=true&description=Invoice%20%2319%20%26%20co',
    );
  });
});

describe('createIntent', () => {
  it('sends minor units unconverted', async () => {
    respondWith(succeededIntent());
    await new StripeGatewayAdapter(ENV_STUB).createIntent(baseInput());

    // The whole point: Stripe's amount IS the domain's Minor. A 468.00 charge
    // must go out as 46800, never as 468.
    expect(sentBody().get('amount')).toBe('46800');
    expect(sentBody().get('currency')).toBe('usd');
  });

  it('sends the idempotency key as a header', async () => {
    respondWith(succeededIntent());
    await new StripeGatewayAdapter(ENV_STUB).createIntent(baseInput({ idempotencyKey: 'idem-9' }));

    expect(sentHeaders()['Idempotency-Key']).toBe('idem-9');
  });

  it('pins the API version', async () => {
    respondWith(succeededIntent());
    await new StripeGatewayAdapter(ENV_STUB).createIntent(baseInput());

    expect(sentHeaders()['Stripe-Version']).toBe('2024-06-20');
  });

  it('confirms immediately when a source is supplied', async () => {
    respondWith(succeededIntent());
    const result = await new StripeGatewayAdapter(ENV_STUB).createIntent(baseInput());

    const body = sentBody();
    expect(body.get('payment_method')).toBe('pm_card_visa');
    expect(body.get('confirm')).toBe('true');
    expect(body.get('return_url')).toBe('https://pay.example.com/i/tok');
    expect(result.status).toBe('SUCCEEDED');
    expect(result.gatewayReference).toBe('pi_3ABC');
  });

  it('creates an unconfirmed intent and returns the client secret when no source is given', async () => {
    respondWith(
      succeededIntent({ status: 'requires_payment_method', amount_received: 0, last_payment_error: undefined }),
    );
    const result = await new StripeGatewayAdapter(ENV_STUB).createIntent(
      baseInput({ source: undefined }),
    );

    expect(sentBody().get('confirm')).toBeNull();
    expect(sentBody().get('payment_method')).toBeNull();
    expect(result.status).toBe('REQUIRES_ACTION');
    expect(result.clientToken).toBe('pi_3ABC_secret_xyz');
  });

  it('carries the invoice and brand as metadata', async () => {
    respondWith(succeededIntent());
    await new StripeGatewayAdapter(ENV_STUB).createIntent(baseInput());

    const body = sentBody();
    expect(body.get('metadata[invoice_id]')).toBe('inv-123');
    expect(body.get('metadata[brand_id]')).toBe('brand-1');
  });

  it('reports the received amount over the requested one', async () => {
    // Partial capture: amount_received is what actually settled.
    respondWith(succeededIntent({ amount: 46_800, amount_received: 40_000 }));
    const result = await new StripeGatewayAdapter(ENV_STUB).createIntent(baseInput());

    expect(result.amountMinor).toBe(40_000);
  });

  it('refuses a currency the platform does not support', async () => {
    const adapter = new StripeGatewayAdapter(ENV_STUB);
    await expect(
      adapter.createIntent(baseInput({ currency: 'JPY' as 'USD' })),
    ).rejects.toThrow(IntegrationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails without a secret key rather than calling out unauthenticated', async () => {
    const adapter = new StripeGatewayAdapter({ ...ENV_STUB, STRIPE_SECRET_KEY: undefined } as Env);
    await expect(adapter.createIntent(baseInput())).rejects.toMatchObject({
      errorClass: 'AUTHENTICATION',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('status mapping', () => {
  it.each([
    ['succeeded', 'SUCCEEDED'],
    ['processing', 'PROCESSING'],
    ['requires_action', 'REQUIRES_ACTION'],
    ['requires_confirmation', 'REQUIRES_ACTION'],
    ['canceled', 'CANCELLED'],
  ])('maps %s to %s', async (stripeStatus, expected) => {
    respondWith(succeededIntent({ status: stripeStatus }));
    const result = await new StripeGatewayAdapter(ENV_STUB).retrieve('pi_3ABC');
    expect(result.status).toBe(expected);
  });

  it('treats requires_capture as PROCESSING, not SUCCEEDED', async () => {
    // Authorised but not captured: the money has not moved, and calling it
    // settled would mark the invoice paid on an authorisation that can expire.
    respondWith(succeededIntent({ status: 'requires_capture' }));
    const result = await new StripeGatewayAdapter(ENV_STUB).retrieve('pi_3ABC');
    expect(result.status).toBe('PROCESSING');
  });

  it('distinguishes a decline from a fresh intent, both of which are requires_payment_method', async () => {
    respondWith(
      succeededIntent({
        status: 'requires_payment_method',
        last_payment_error: { message: 'Your card was declined.', decline_code: 'do_not_honor' },
      }),
    );
    const result = await new StripeGatewayAdapter(ENV_STUB).retrieve('pi_3ABC');

    expect(result.status).toBe('FAILED');
    expect(result.declineReason).toBe('Your card was declined.');
  });
});

describe('error classification', () => {
  it('classifies a card decline as VALIDATION', async () => {
    respondWith(
      { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' } },
      { status: 402 },
    );

    await expect(new StripeGatewayAdapter(ENV_STUB).createIntent(baseInput())).rejects.toMatchObject({
      errorClass: 'VALIDATION',
      // decline_code is the issuer's reason and beats the generic code.
      providerCode: 'insufficient_funds',
      providerMessage: 'Your card has insufficient funds.',
    });
  });

  it('classifies a revoked key as AUTHENTICATION', async () => {
    respondWith({ error: { type: 'authentication_error', message: 'Invalid API Key' } }, { status: 401 });
    await expect(new StripeGatewayAdapter(ENV_STUB).retrieve('pi_1')).rejects.toMatchObject({
      errorClass: 'AUTHENTICATION',
    });
  });

  it('classifies a reused idempotency key as CONFLICT, never a retry', async () => {
    respondWith({ error: { type: 'idempotency_error', message: 'Keys for idempotent requests…' } }, { status: 400 });
    await expect(new StripeGatewayAdapter(ENV_STUB).createIntent(baseInput())).rejects.toMatchObject({
      errorClass: 'CONFLICT',
    });
  });

  it('surfaces Retry-After on a rate limit', async () => {
    respondWith({ error: { type: 'rate_limit_error', message: 'Too many requests' } }, {
      status: 429,
      headers: { 'Retry-After': '2' },
    });
    await expect(new StripeGatewayAdapter(ENV_STUB).retrieve('pi_1')).rejects.toMatchObject({
      errorClass: 'TRANSIENT',
      retryAfterMs: 2000,
    });
  });

  /**
   * The contrast with Numbers that justifies the whole adapter: a charge whose
   * response was never seen is safe to retry here, because the idempotency key
   * makes the replay either a first delivery or a replayed answer.
   */
  it('treats an unanswered charge as TRANSIENT, because the idempotency key makes a retry safe', async () => {
    fetchMock.mockRejectedValue(new Error('socket hang up'));

    await expect(new StripeGatewayAdapter(ENV_STUB).createIntent(baseInput())).rejects.toMatchObject({
      errorClass: 'TRANSIENT',
    });
  });
});

describe('refund', () => {
  it('passes through a reason Stripe accepts', async () => {
    respondWith({ id: 're_1', amount: 1000, status: 'succeeded', created: 1_785_000_000 });
    const result = await new StripeGatewayAdapter(ENV_STUB).refund({
      gatewayReference: 'pi_3ABC',
      amountMinor: 1000,
      reason: 'requested_by_customer',
      idempotencyKey: 'idem-r',
    });

    expect(sentBody().get('reason')).toBe('requested_by_customer');
    expect(result).toMatchObject({ refundReference: 're_1', status: 'SUCCEEDED', amountMinor: 1000 });
  });

  it('preserves an arbitrary reason as metadata instead of forcing it into an enum', async () => {
    respondWith({ id: 're_2', amount: 500, status: 'pending', created: 1_785_000_000 });
    await new StripeGatewayAdapter(ENV_STUB).refund({
      gatewayReference: 'pi_3ABC',
      amountMinor: 500,
      reason: 'goodwill gesture after a delivery delay',
      idempotencyKey: 'idem-r2',
    });

    expect(sentBody().get('reason')).toBeNull();
    expect(sentBody().get('metadata[reason]')).toBe('goodwill gesture after a delivery delay');
  });

  it('throws when the refund itself fails', async () => {
    respondWith({ id: 're_3', amount: 500, status: 'failed', failure_reason: 'expired_or_canceled_card', created: 1 });
    await expect(
      new StripeGatewayAdapter(ENV_STUB).refund({
        gatewayReference: 'pi_3ABC',
        amountMinor: 500,
        idempotencyKey: 'idem-r3',
      }),
    ).rejects.toThrow(IntegrationError);
  });
});

describe('verifySignature', () => {
  const adapter = () => new StripeGatewayAdapter(ENV_STUB);

  function sign(payload: string, timestamp: number, secret = WEBHOOK_SECRET): string {
    const signature = createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    return `t=${timestamp},v1=${signature}`;
  }

  const payload = JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' });

  it('accepts a correctly signed, fresh payload', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(adapter().verifySignature(payload, { 'stripe-signature': sign(payload, now) })).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const now = Math.floor(Date.now() / 1000);
    const header = sign(payload, now);
    expect(adapter().verifySignature(`${payload} `, { 'stripe-signature': header })).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(
      adapter().verifySignature(payload, { 'stripe-signature': sign(payload, now, 'whsec_wrong') }),
    ).toBe(false);
  });

  // The signature of an old delivery is still valid forever; the timestamp is
  // the only thing standing between us and a replay.
  it('rejects a stale delivery outside the tolerance window', () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    expect(adapter().verifySignature(payload, { 'stripe-signature': sign(payload, old) })).toBe(false);
  });

  it('accepts when any one of several v1 signatures matches, as during secret rotation', () => {
    const now = Math.floor(Date.now() / 1000);
    const good = createHmac('sha256', WEBHOOK_SECRET).update(`${now}.${payload}`).digest('hex');
    const header = `t=${now},v1=${'0'.repeat(64)},v1=${good}`;
    expect(adapter().verifySignature(payload, { 'stripe-signature': header })).toBe(true);
  });

  it('rejects a missing header rather than throwing', () => {
    expect(adapter().verifySignature(payload, {})).toBe(false);
  });

  it('rejects everything when no secret is configured', () => {
    const unconfigured = new StripeGatewayAdapter({ ...ENV_STUB, STRIPE_WEBHOOK_SECRET: undefined } as Env);
    const now = Math.floor(Date.now() / 1000);
    expect(unconfigured.verifySignature(payload, { 'stripe-signature': sign(payload, now) })).toBe(false);
  });
});

describe('parseSignatureHeader', () => {
  it('pulls the timestamp and every v1 candidate', () => {
    expect(parseSignatureHeader('t=123,v1=aaa,v0=zzz,v1=bbb')).toEqual({
      timestamp: 123,
      signatures: ['aaa', 'bbb'],
    });
  });

  it('returns nothing usable for a malformed header', () => {
    expect(parseSignatureHeader('garbage')).toEqual({ timestamp: null, signatures: [] });
  });
});

describe('parseWebhook', () => {
  const adapter = () => new StripeGatewayAdapter(ENV_STUB);

  it('reads a payment_intent event', () => {
    const event = adapter().parseWebhook(
      JSON.stringify({
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        created: 1_785_000_000,
        data: { object: succeededIntent() },
      }),
    );

    expect(event).toMatchObject({
      id: 'evt_1',
      type: 'PAYMENT_SUCCEEDED',
      gatewayReference: 'pi_3ABC',
      amountMinor: 46_800,
      currency: 'USD',
    });
    // Stripe's timestamp, not receipt time — unix seconds, not milliseconds.
    expect(event.occurredAt.toISOString()).toBe(new Date(1_785_000_000_000).toISOString());
  });

  it('keys a refund event back to the payment intent, not the refund id', () => {
    const event = adapter().parseWebhook(
      JSON.stringify({
        id: 'evt_2',
        type: 'charge.refunded',
        created: 1_785_000_000,
        data: { object: { id: 'ch_1', payment_intent: 'pi_3ABC', amount: 1000, currency: 'usd' } },
      }),
    );

    expect(event.type).toBe('REFUND_SUCCEEDED');
    expect(event.gatewayReference).toBe('pi_3ABC');
  });

  it('surfaces the decline reason on a failure', () => {
    const event = adapter().parseWebhook(
      JSON.stringify({
        id: 'evt_3',
        type: 'payment_intent.payment_failed',
        created: 1,
        data: { object: { id: 'pi_9', last_payment_error: { message: 'Your card was declined.' } } },
      }),
    );

    expect(event.type).toBe('PAYMENT_FAILED');
    expect(event.declineReason).toBe('Your card was declined.');
  });

  it('reports an unsupported currency as null rather than guessing', () => {
    const event = adapter().parseWebhook(
      JSON.stringify({ id: 'e', type: 'payment_intent.succeeded', created: 1, data: { object: { id: 'pi_1', currency: 'jpy' } } }),
    );
    expect(event.currency).toBeNull();
  });

  it('maps an unrecognised type to UNKNOWN instead of failing', () => {
    expect(toEventType('customer.subscription.created')).toBe('UNKNOWN');
    expect(toEventType(undefined)).toBe('UNKNOWN');
  });
});
