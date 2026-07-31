import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationError, type CreateIntentInput } from '@fenwick/shared';
import type { Env } from '../../config/env.js';
import {
  NumbersGatewayAdapter,
  toDecimalAmount,
  toMinorAmount,
} from './numbers-gateway.adapter.js';

/**
 * The adapter is exercised against a stubbed fetch rather than the sandbox:
 * these assertions must hold without credentials and without a network, and a
 * live sandbox cannot prove what we send — only that something was accepted.
 */

const WEBHOOK_SECRET = 'whsec_test_signature_key';

const ENV_STUB = {
  NUMBERS_API_BASE_URL: 'https://api.sandbox.numbersgateway.com/api/v2',
  NUMBERS_API_KEY: 'src_test_key',
  NUMBERS_API_KEY_PIN: '1234',
  NUMBERS_WEBHOOK_SECRET: WEBHOOK_SECRET,
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
    source: { kind: 'NONCE', token: 'ntok_abc', expiryMonth: 12, expiryYear: 2030 },
    ...overrides,
  };
}

function approvedResponse(overrides: Record<string, unknown> = {}) {
  return {
    status: 'Approved',
    status_code: 'A',
    auth_amount: 468,
    auth_code: 'OK123',
    reference_number: 55,
    transaction: {
      id: 9001,
      created_at: '2026-07-30T12:00:00.000Z',
      status_details: { status: 'captured' },
      transaction_details: { reference_number: 55 },
    },
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function respondWith(payload: unknown, init: { status?: number } = {}): void {
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function adapter(): NumbersGatewayAdapter {
  return new NumbersGatewayAdapter(ENV_STUB);
}

function lastBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.at(-1);
  return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
}

describe('amount conversion', () => {
  it('converts minor units to decimal dollars without float drift', () => {
    expect(toDecimalAmount(46_800)).toBe(468);
    expect(toDecimalAmount(7)).toBe(0.07);
    expect(toDecimalAmount(1)).toBe(0.01);
    expect(toDecimalAmount(199_999)).toBe(1999.99);
    // The wire form is what the gateway parses, so it must be exact.
    expect(JSON.stringify({ amount: toDecimalAmount(7) })).toBe('{"amount":0.07}');
    expect(JSON.stringify({ amount: toDecimalAmount(1010) })).toBe('{"amount":10.1}');
  });

  it('round-trips back to minor units', () => {
    for (const minor of [1, 7, 99, 100, 46_800, 1_234_567]) {
      expect(toMinorAmount(toDecimalAmount(minor))).toBe(minor);
    }
  });
});

describe('createIntent', () => {
  it('spends a hosted-tokenization nonce as a nonce- source', async () => {
    respondWith(approvedResponse());

    const intent = await adapter().createIntent(baseInput());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.sandbox.numbersgateway.com/api/v2/transactions/charge');
    expect(init.method).toBe('POST');

    const body = lastBody();
    expect(body['source']).toBe('nonce-ntok_abc');
    expect(body['amount']).toBe(468);
    expect(body['expiry_month']).toBe(12);
    // The invoice id travels with the transaction for gateway-side tracing.
    expect((body['transaction_details'] as Record<string, unknown>)['invoice_number']).toBe(
      'inv-123',
    );

    expect(intent.status).toBe('SUCCEEDED');
    expect(intent.gatewayReference).toBe('9001');
    expect(intent.amountMinor).toBe(46_800);
  });

  it('authenticates with HTTP Basic over key:pin', async () => {
    respondWith(approvedResponse());
    await adapter().createIntent(baseInput());

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const header = (init.headers as Record<string, string>)['Authorization'];
    expect(header).toBe(`Basic ${Buffer.from('src_test_key:1234').toString('base64')}`);
  });

  it('sends a wallet payload as an encrypted token, not a nonce', async () => {
    respondWith(approvedResponse());

    await adapter().createIntent(
      baseInput({
        method: 'WALLET',
        source: { kind: 'WALLET', token: 'encrypted-payload', walletProvider: 'GOOGLE_PAY', binType: 'C' },
      }),
    );

    const body = lastBody();
    expect(body['source']).toBe('googlepay');
    expect(body['token']).toBe('encrypted-payload');
    expect(body['bin_type']).toBe('C');
  });

  it('reports the authorised amount when a surcharge changes it', async () => {
    // The provider may charge more than we asked when a mandatory surcharge
    // is configured; the response is authoritative.
    respondWith(approvedResponse({ auth_amount: 482.04 }));

    const intent = await adapter().createIntent(baseInput());

    expect(intent.amountMinor).toBe(48_204);
  });

  it('maps a decline to FAILED with the provider reason rather than throwing', async () => {
    respondWith({
      status: 'Declined',
      status_code: 'D',
      error_message: 'insufficient funds',
      transaction: { id: 9002, status_details: { status: 'declined' } },
    });

    const intent = await adapter().createIntent(baseInput());

    expect(intent.status).toBe('FAILED');
    expect(intent.declineReason).toBe('insufficient funds');
  });

  it('treats an ACH charge as unsupported instead of sending a card-shaped request', async () => {
    await expect(adapter().createIntent(baseInput({ method: 'ACH' }))).rejects.toThrow(
      /bank account details/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a non-USD charge', async () => {
    await expect(adapter().createIntent(baseInput({ currency: 'EUR' }))).rejects.toThrow(/USD only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to charge without a tokenized source', async () => {
    await expect(
      adapter().createIntent(baseInput({ source: undefined })),
    ).rejects.toThrow(/payment source is required/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the first result for a repeated idempotency key without charging again', async () => {
    respondWith(approvedResponse());
    const gateway = adapter();

    const first = await gateway.createIntent(baseInput());
    const second = await gateway.createIntent(baseInput());

    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('classifies a charge timeout as non-retryable, because a replay could double-charge', async () => {
    fetchMock.mockRejectedValue(new Error('The operation was aborted due to timeout'));

    const error = await adapter()
      .createIntent(baseInput())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(IntegrationError);
    // TRANSIENT would mean "retry me" — precisely what must not happen when the
    // gateway offers no idempotency key.
    expect((error as IntegrationError).errorClass).toBe('PERMANENT');
    expect((error as IntegrationError).retryable).toBe(false);
  });

  it('treats a 5xx on a charge as indeterminate rather than retryable', async () => {
    respondWith({ error: 'boom' }, { status: 503 });

    const error = await adapter()
      .createIntent(baseInput())
      .catch((e: unknown) => e);

    expect((error as IntegrationError).errorClass).toBe('PERMANENT');
  });

  it('surfaces a 401 as an authentication failure', async () => {
    respondWith({ error: 'bad credentials' }, { status: 401 });

    const error = await adapter()
      .createIntent(baseInput())
      .catch((e: unknown) => e);

    expect((error as IntegrationError).errorClass).toBe('AUTHENTICATION');
  });
});

describe('refund, void and capture', () => {
  it('keys a refund off the reference number learned from the charge', async () => {
    const gateway = adapter();
    respondWith(approvedResponse());
    await gateway.createIntent(baseInput());

    respondWith({
      status: 'Approved',
      status_code: 'A',
      auth_amount: 100,
      reference_number: 56,
      transaction: { id: 9003, status_details: { status: 'captured' } },
    });

    const result = await gateway.refund({
      gatewayReference: '9001',
      amountMinor: 10_000,
      idempotencyKey: 'idem-refund',
    });

    const body = lastBody();
    // 55 came from the charge response, so no extra lookup was needed.
    expect(body['reference_number']).toBe(55);
    expect(body['amount']).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('SUCCEEDED');
    expect(result.amountMinor).toBe(10_000);
  });

  it('looks the reference number up when the charge was made by another process', async () => {
    const gateway = adapter();

    // Cold cache: a GET resolves the reference number first.
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(approvedResponse()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status_code: 'A', transaction: { id: 9004, status_details: { status: 'voided' } } }),
          { status: 200 },
        ),
      );

    const intent = await gateway.void('9001');

    const [lookupUrl] = fetchMock.mock.calls[0] as [string];
    expect(lookupUrl).toBe('https://api.sandbox.numbersgateway.com/api/v2/transactions/9001');
    expect(intent.status).toBe('CANCELLED');
  });

  it('raises a declined refund rather than reporting it as succeeded', async () => {
    const gateway = adapter();
    respondWith(approvedResponse());
    await gateway.createIntent(baseInput());

    respondWith({ status: 'Declined', status_code: 'D', error_message: 'refund not permitted' });

    await expect(
      gateway.refund({ gatewayReference: '9001', amountMinor: 100, idempotencyKey: 'r' }),
    ).rejects.toThrow(/refund was declined/);
  });
});

describe('webhook verification', () => {
  const body = JSON.stringify({ type: 'succeeded', event: 'transaction', id: 'evt_1' });

  function sign(payload: string, secret = WEBHOOK_SECRET): string {
    return createHmac('sha256', secret).update(payload).digest('hex');
  }

  it('accepts a correctly signed payload', () => {
    expect(adapter().verifySignature(body, { 'x-signature': sign(body) })).toBe(true);
  });

  it('rejects a payload signed with the wrong key', () => {
    expect(adapter().verifySignature(body, { 'x-signature': sign(body, 'wrong') })).toBe(false);
  });

  it('rejects a tampered body', () => {
    const signature = sign(body);
    expect(adapter().verifySignature(`${body} `, { 'x-signature': signature })).toBe(false);
  });

  it('rejects an unsigned probe instead of throwing', () => {
    expect(adapter().verifySignature(body, {})).toBe(false);
  });
});

describe('webhook parsing', () => {
  it('maps a successful charge event', () => {
    const event = adapter().parseWebhook(
      JSON.stringify({
        type: 'succeeded',
        subType: 'charge',
        event: 'transaction',
        id: 'evt_100',
        timestamp: '2026-07-30T12:00:00.000Z',
        data: { auth_amount: 468, transaction: { id: 9001 } },
      }),
    );

    expect(event.type).toBe('PAYMENT_SUCCEEDED');
    expect(event.id).toBe('evt_100');
    expect(event.gatewayReference).toBe('9001');
    expect(event.amountMinor).toBe(46_800);
    expect(event.occurredAt.toISOString()).toBe('2026-07-30T12:00:00.000Z');
  });

  it('distinguishes a refund from a payment', () => {
    const event = adapter().parseWebhook(
      JSON.stringify({
        type: 'succeeded',
        subType: 'refund',
        event: 'transaction',
        id: 'evt_101',
        data: { transaction: { id: 9002 } },
      }),
    );

    expect(event.type).toBe('REFUND_SUCCEEDED');
  });

  it('maps an ACH status event to the payment lifecycle', () => {
    const settled = adapter().parseWebhook(
      JSON.stringify({
        type: 'status',
        subType: 'settled',
        event: 'transaction',
        id: 'evt_102',
        data: { id: 9003 },
      }),
    );
    const returned = adapter().parseWebhook(
      JSON.stringify({
        type: 'status',
        subType: 'returned',
        event: 'transaction',
        id: 'evt_103',
        data: { id: 9003 },
      }),
    );

    expect(settled.type).toBe('PAYMENT_SUCCEEDED');
    expect(settled.gatewayReference).toBe('9003');
    expect(returned.type).toBe('PAYMENT_FAILED');
  });

  it('ignores events that carry no payment outcome', () => {
    const event = adapter().parseWebhook(
      JSON.stringify({ type: 'close', event: 'batch', id: 'evt_104', data: { id: 1 } }),
    );

    expect(event.type).toBe('UNKNOWN');
  });
});
