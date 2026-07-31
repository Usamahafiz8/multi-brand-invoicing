import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IntegrationError,
  classifyHttpStatus,
  type CaptureInput,
  type CreateIntentInput,
  type CurrencyCode,
  type GatewayWebhookEvent,
  type Minor,
  type PaymentGatewayPort,
  type PaymentIntent,
  type PaymentIntentStatus,
  type PaymentSourceInput,
  type RefundInput,
  type RefundResult,
} from '@fenwick/shared';
import { ENV, type Env } from '../../config/env.js';

/**
 * NumbersGatewayAdapter — Numbers Payments Gateway API v2.
 *
 * DEP-01 is resolved. The provider's documentation is a client-rendered SPA, so
 * fetching docs.numbersgateway.com without a JavaScript engine returns an empty
 * shell — which is what previously read as "no readable content". The contract
 * below is taken from the rendered documentation:
 *
 *   Sandbox     https://api.sandbox.numbersgateway.com/api/v2
 *   Production  https://api.numbersgateway.com/api/v2
 *
 * Three properties of this provider drive the design here, and each contradicts
 * an assumption that was reasonable before the contract could be read:
 *
 * 1. NO REQUEST-LEVEL IDEMPOTENCY. The API offers no idempotency key on any
 *    endpoint; only webhook *events* carry one. A charge whose response we did
 *    not see is therefore INDETERMINATE, not retryable — replaying it can take
 *    the customer's money twice. See `indeterminate()`.
 * 2. AMOUNTS ARE DECIMAL DOLLARS, not minor units. The domain is integer minor
 *    units end to end (TDD-001 §9.1), so conversion happens here and nowhere
 *    else, by exact integer arithmetic rather than float division.
 * 3. A MANDATORY SURCHARGE SET BY THE ISO/MSP CAN CHANGE THE AMOUNT CHARGED.
 *    What we asked for is not necessarily what was taken, so every response is
 *    read back for the authorised figure rather than assumed to match.
 *
 * Card data never reaches this process. The payment page collects it in the
 * gateway's hosted-tokenization iframes and sends us only a nonce, which is
 * spent here as `source: "nonce-<token>"`. That is what keeps the API inside
 * PCI SAQ A scope.
 */

/** Transaction lifecycle states, from the /transactions status filter enum. */
const SETTLED_STATUSES = new Set(['captured', 'settled', 'approved']);
const PENDING_STATUSES = new Set(['pending', 'reserve', 'originated', 'queued']);
const FAILED_STATUSES = new Set(['declined', 'error', 'returned', 'blocked', 'expired']);
const CANCELLED_STATUSES = new Set(['voided', 'cancelled']);

/** The gateway prices exclusively in USD ("Transaction amount in USD"). */
const GATEWAY_CURRENCY: CurrencyCode = 'USD';

const DEFAULT_TIMEOUT_MS = 30_000;

interface ChargeResponse {
  readonly status?: string;
  readonly status_code?: string;
  readonly error_message?: string | null;
  readonly error_code?: string | null;
  readonly error_details?: string | null;
  readonly auth_amount?: number | null;
  readonly auth_code?: string | null;
  readonly reference_number?: number | null;
  readonly id?: number | null;
  readonly amount_details?: { readonly amount?: number | null } | null;
  readonly status_details?: { readonly status?: string | null } | null;
  readonly transaction?: {
    readonly id?: number | null;
    readonly created_at?: string | null;
    readonly amount_details?: { readonly amount?: number | null } | null;
    readonly transaction_details?: { readonly reference_number?: number | null } | null;
    readonly status_details?: { readonly status?: string | null } | null;
  } | null;
}

@Injectable()
export class NumbersGatewayAdapter implements PaymentGatewayPort {
  readonly providerName = 'numbers-gateway';

  private readonly logger = new Logger(NumbersGatewayAdapter.name);

  /**
   * `reference_number` is what capture/void/refund/reversal key off, but
   * `transaction.id` is what GET /transactions/{id} addresses, and the provider
   * models them as distinct concepts. We publish the transaction id as the
   * gateway reference (it is the addressable resource) and remember the
   * reference number so the common path needs no extra round trip. A cold cache
   * falls back to a lookup: a restart costs latency, not correctness.
   */
  private readonly referenceNumbers = new Map<string, number>();

  /**
   * Charges already answered in this process, keyed by idempotency key. The
   * provider offers no idempotency of its own, so this is all that is
   * available here — deliberately in-process, and deliberately not a substitute
   * for the unique constraint on the payment attempt, which is what actually
   * prevents a double charge across instances.
   */
  private readonly seenCharges = new Map<string, PaymentIntent>();

  constructor(@Inject(ENV) private readonly env: Env) {}

  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    const cached = this.seenCharges.get(input.idempotencyKey);
    if (cached) return cached;

    if (input.currency !== GATEWAY_CURRENCY) {
      throw this.validation(
        `Numbers Gateway settles in ${GATEWAY_CURRENCY} only; refusing a ${input.currency} charge`,
      );
    }

    const body = {
      amount: toDecimalAmount(input.amountMinor),
      ...this.sourceFields(input),
      ...(input.customer.name ? { name: input.customer.name.slice(0, 255) } : {}),
      transaction_details: {
        description: input.description.slice(0, 255),
        // Our invoice id travels with the transaction, so a gateway-side record
        // can be traced back without consulting our database.
        invoice_number: input.invoiceId,
      },
    };

    // A charge is the one call we cannot safely repeat, so transport failures
    // are reported as indeterminate rather than transient.
    const response = await this.request<ChargeResponse>('POST', '/transactions/charge', body, {
      moneyMoving: true,
    });

    const intent = this.toIntent(response, input.amountMinor);
    this.remember(intent, response);
    this.seenCharges.set(input.idempotencyKey, intent);
    return intent;
  }

  async capture(input: CaptureInput): Promise<PaymentIntent> {
    const referenceNumber = await this.referenceNumberFor(input.gatewayReference);
    const response = await this.request<ChargeResponse>(
      'POST',
      '/transactions/capture',
      {
        reference_number: referenceNumber,
        ...(input.amountMinor === undefined ? {} : { amount: toDecimalAmount(input.amountMinor) }),
      },
      { moneyMoving: true },
    );
    return this.toIntent(response, input.amountMinor ?? 0);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const referenceNumber = await this.referenceNumberFor(input.gatewayReference);
    const response = await this.request<ChargeResponse>(
      'POST',
      '/transactions/refund',
      { reference_number: referenceNumber, amount: toDecimalAmount(input.amountMinor) },
      { moneyMoving: true },
    );

    const status = this.toStatus(response);
    if (status === 'FAILED') throw this.declined(response, 'refund was declined');

    return {
      // The refund is its own transaction and carries its own identity.
      refundReference: String(response.transaction?.id ?? response.reference_number ?? ''),
      amountMinor: authorisedMinor(response) ?? input.amountMinor,
      status: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'PENDING',
      occurredAt: occurredAt(response),
    };
  }

  async void(gatewayReference: string): Promise<PaymentIntent> {
    const referenceNumber = await this.referenceNumberFor(gatewayReference);
    const response = await this.request<ChargeResponse>(
      'POST',
      '/transactions/void',
      { reference_number: referenceNumber },
      { moneyMoving: true },
    );
    // A successful void is terminal regardless of how the provider labels the
    // resulting transaction row.
    return { ...this.toIntent(response, 0), status: 'CANCELLED' };
  }

  async retrieve(gatewayReference: string): Promise<PaymentIntent> {
    const response = await this.request<ChargeResponse>(
      'GET',
      `/transactions/${encodeURIComponent(gatewayReference)}`,
      undefined,
      { moneyMoving: false },
    );
    return this.toIntent(response, authorisedMinor(response) ?? 0);
  }

  /**
   * X-Signature is the hex HMAC-SHA256 of the raw request body, keyed by the
   * endpoint's signature key. It must be computed over the bytes as received —
   * re-serialising the parsed JSON would change the hash — which is why the
   * Nest app is created with `rawBody: true`.
   */
  verifySignature(payload: string | Buffer, headers: Readonly<Record<string, string>>): boolean {
    const secret = this.env.NUMBERS_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.error('NUMBERS_WEBHOOK_SECRET is not configured; rejecting webhook');
      return false;
    }

    const provided = headers['x-signature'] ?? headers['X-Signature'];
    if (!provided) return false;

    const expected = createHmac('sha256', secret).update(payload).digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    // Length check first: timingSafeEqual throws on a length mismatch.
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseWebhook(payload: string | Buffer): GatewayWebhookEvent {
    const body = JSON.parse(payload.toString()) as {
      type?: string;
      subType?: string;
      event?: string;
      id?: string;
      timestamp?: string;
      data?: ChargeResponse;
    };

    const data = body.data ?? {};
    // A transaction event's `data` is a charge response (identity under
    // `transaction.id`); a status event's `data` is the transaction itself.
    const reference = data.transaction?.id ?? data.id ?? data.reference_number ?? '';

    return {
      id: String(body.id ?? ''),
      type: this.toEventType(body.event, body.type, body.subType),
      gatewayReference: String(reference),
      amountMinor: authorisedMinor(data),
      currency: GATEWAY_CURRENCY,
      occurredAt: body.timestamp ? new Date(body.timestamp) : new Date(),
      declineReason: data.error_message ?? null,
      raw: body,
    };
  }

  // --- Request plumbing ----------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    options: { moneyMoving: boolean },
  ): Promise<T> {
    const { baseUrl, authorization } = this.credentials();

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          // The provider asks integrations to identify themselves so their
          // support can trace our traffic.
          'User-Agent': 'FenwickInvoicing/1.0 (+numbers-gateway-adapter)',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      // No response was seen at all. For a read that is merely transient; for a
      // charge it means the money may or may not have moved.
      if (options.moneyMoving) throw this.indeterminate(path, cause);
      throw new IntegrationError({
        message: `Numbers Gateway did not respond to ${method} ${path}`,
        errorClass: 'TRANSIENT',
        provider: this.providerName,
        cause,
      });
    }

    const text = await response.text();

    if (!response.ok) {
      // A money-moving call that fails with 5xx is still indeterminate: the
      // gateway may have processed it before failing to tell us so.
      if (options.moneyMoving && response.status >= 500) {
        throw this.indeterminate(path, new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`));
      }
      throw new IntegrationError({
        message: `Numbers Gateway rejected ${method} ${path} with ${response.status}`,
        errorClass: classifyHttpStatus(response.status),
        provider: this.providerName,
        providerMessage: text.slice(0, 1000),
        httpStatus: response.status,
      });
    }

    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new IntegrationError({
        message: `Numbers Gateway returned a non-JSON body for ${method} ${path}`,
        errorClass: 'PERMANENT',
        provider: this.providerName,
        providerMessage: text.slice(0, 500),
        cause,
      });
    }
  }

  private credentials(): { baseUrl: string; authorization: string } {
    const baseUrl = this.env.NUMBERS_API_BASE_URL;
    const key = this.env.NUMBERS_API_KEY;
    const pin = this.env.NUMBERS_API_KEY_PIN;

    // Configuration is validated at boot when the driver is selected; this
    // guard covers the case where the adapter is reached by another route.
    if (!baseUrl || !key || !pin) {
      throw new IntegrationError({
        message:
          'Numbers Gateway is not configured (needs NUMBERS_API_BASE_URL, NUMBERS_API_KEY, NUMBERS_API_KEY_PIN)',
        errorClass: 'AUTHENTICATION',
        provider: this.providerName,
      });
    }

    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      authorization: `Basic ${Buffer.from(`${key}:${pin}`).toString('base64')}`,
    };
  }

  /**
   * Builds the source fields for the instrument being charged. Each branch maps
   * onto one of the provider's charge request variants.
   */
  private sourceFields(input: CreateIntentInput): Record<string, unknown> {
    if (input.method === 'ACH' || input.method === 'CHECK') {
      // A Check/ACH charge requires routing and account numbers, which nothing
      // in this system collects yet. Failing loudly beats sending a card-shaped
      // request and having the gateway reject it for reasons that read as a bug.
      throw this.validation(
        `${input.method} charges need bank account details, which the payment page does not collect yet`,
      );
    }

    const source = input.source;
    if (!source) {
      throw this.validation(
        'a payment source is required: the card must be tokenized by the hosted-tokenization library first',
      );
    }

    if (input.method === 'WALLET') return walletFields(source);

    if (source.kind === 'WALLET') {
      throw this.validation('a wallet source cannot be charged as a card');
    }

    return {
      // A hosted-tokenization nonce is spent as `nonce-<token>`; a stored
      // instrument is referenced directly.
      source: source.kind === 'NONCE' ? `nonce-${source.token}` : source.token,
      ...(source.expiryMonth === undefined ? {} : { expiry_month: source.expiryMonth }),
      ...(source.expiryYear === undefined ? {} : { expiry_year: source.expiryYear }),
      ...(source.avsZip === undefined ? {} : { avs_zip: source.avsZip }),
      ...(source.avsAddress === undefined ? {} : { avs_address: source.avsAddress }),
    };
  }

  // --- Mapping -------------------------------------------------------------

  private toIntent(response: ChargeResponse, requestedMinor: Minor): PaymentIntent {
    const status = this.toStatus(response);
    return {
      gatewayReference: String(response.transaction?.id ?? response.id ?? response.reference_number ?? ''),
      status,
      // The authorised amount wins over the requested one: a mandatory
      // surcharge or a partial approval means the two can differ.
      amountMinor: authorisedMinor(response) ?? requestedMinor,
      currency: GATEWAY_CURRENCY,
      actionUrl: null,
      clientToken: null,
      occurredAt: occurredAt(response),
      declineReason: status === 'FAILED' ? declineReason(response) : null,
      raw: response,
    };
  }

  private toStatus(response: ChargeResponse): PaymentIntentStatus {
    // The lifecycle status is the more specific signal where the provider
    // supplies it — it is the only thing distinguishing an ACH charge that is
    // merely originated from one that has settled.
    const lifecycle = (
      response.transaction?.status_details?.status ??
      response.status_details?.status ??
      ''
    ).toLowerCase();

    if (lifecycle) {
      if (SETTLED_STATUSES.has(lifecycle)) return 'SUCCEEDED';
      if (PENDING_STATUSES.has(lifecycle)) return 'PROCESSING';
      if (CANCELLED_STATUSES.has(lifecycle)) return 'CANCELLED';
      if (FAILED_STATUSES.has(lifecycle)) return 'FAILED';
    }

    switch ((response.status_code ?? '').toUpperCase()) {
      case 'A':
      case 'P': // Partially approved: authorised, for less than we asked.
        return 'SUCCEEDED';
      case 'D':
      case 'E':
        return 'FAILED';
      default:
        break;
    }

    const status = (response.status ?? '').toLowerCase();
    if (status.startsWith('approved') || status.startsWith('partially')) return 'SUCCEEDED';
    if (status.startsWith('declined') || status.startsWith('error')) return 'FAILED';
    return 'PROCESSING';
  }

  private toEventType(
    event: string | undefined,
    type: string | undefined,
    subType: string | undefined,
  ): GatewayWebhookEvent['type'] {
    // Batch and account-updater events are real but carry no payment outcome,
    // so they resolve to UNKNOWN and are ignored rather than misread.
    if (event !== 'transaction') return 'UNKNOWN';

    const isRefund = subType === 'refund' || subType === 'credit';

    switch (type) {
      case 'succeeded':
        return isRefund ? 'REFUND_SUCCEEDED' : 'PAYMENT_SUCCEEDED';
      case 'declined':
      case 'error':
        return isRefund ? 'REFUND_FAILED' : 'PAYMENT_FAILED';
      case 'updated':
        return subType === 'void' ? 'PAYMENT_CANCELLED' : 'UNKNOWN';
      case 'status':
        // ACH lifecycle; subType is the transaction's new status.
        if (!subType) return 'UNKNOWN';
        if (SETTLED_STATUSES.has(subType)) return 'PAYMENT_SUCCEEDED';
        if (PENDING_STATUSES.has(subType)) return 'PAYMENT_PENDING';
        if (CANCELLED_STATUSES.has(subType)) return 'PAYMENT_CANCELLED';
        if (FAILED_STATUSES.has(subType)) return 'PAYMENT_FAILED';
        return 'UNKNOWN';
      default:
        return 'UNKNOWN';
    }
  }

  private remember(intent: PaymentIntent, response: ChargeResponse): void {
    const referenceNumber =
      response.reference_number ?? response.transaction?.transaction_details?.reference_number;
    if (intent.gatewayReference && typeof referenceNumber === 'number') {
      this.referenceNumbers.set(intent.gatewayReference, referenceNumber);
    }
  }

  private async referenceNumberFor(gatewayReference: string): Promise<number> {
    const cached = this.referenceNumbers.get(gatewayReference);
    if (cached !== undefined) return cached;

    const response = await this.request<ChargeResponse>(
      'GET',
      `/transactions/${encodeURIComponent(gatewayReference)}`,
      undefined,
      { moneyMoving: false },
    );
    const referenceNumber =
      response.reference_number ?? response.transaction?.transaction_details?.reference_number;

    if (typeof referenceNumber !== 'number') {
      throw new IntegrationError({
        message: `transaction ${gatewayReference} has no reference number to act on`,
        errorClass: 'PERMANENT',
        provider: this.providerName,
      });
    }

    this.referenceNumbers.set(gatewayReference, referenceNumber);
    return referenceNumber;
  }

  // --- Errors --------------------------------------------------------------

  /**
   * A money-moving call whose outcome we never observed. Classified PERMANENT
   * rather than TRANSIENT on purpose: TRANSIENT means "retry me", and retrying
   * a charge the gateway may already have processed is how a customer gets
   * billed twice. This halts and raises an operator alert instead — the
   * transaction must be reconciled against GET /transactions before any retry.
   */
  private indeterminate(path: string, cause: unknown): IntegrationError {
    this.logger.error(
      `INDETERMINATE ${path}: no confirmed outcome. Reconcile before retrying — ` +
        'the gateway has no idempotency key, so a replay may charge twice.',
    );
    return new IntegrationError({
      message: `Numbers Gateway ${path} outcome is unknown; reconcile before retrying`,
      errorClass: 'PERMANENT',
      provider: this.providerName,
      providerMessage: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
  }

  private declined(response: ChargeResponse, message: string): IntegrationError {
    return new IntegrationError({
      message,
      errorClass: 'VALIDATION',
      provider: this.providerName,
      providerMessage: declineReason(response) ?? undefined,
      providerCode: response.error_code ?? undefined,
    });
  }

  private validation(message: string): IntegrationError {
    return new IntegrationError({
      message,
      errorClass: 'VALIDATION',
      provider: this.providerName,
    });
  }
}

// --- Pure helpers ----------------------------------------------------------

/**
 * Minor units to the decimal dollars the gateway expects.
 *
 * Built by integer arithmetic and string assembly, never by dividing a float:
 * `Number('0.07')` is the nearest double to 0.07 and re-serialises as exactly
 * "0.07", whereas `7 / 100` invites the representation drift this codebase
 * avoids everywhere else (TDD-001 §9.1).
 */
export function toDecimalAmount(amountMinor: Minor): number {
  const sign = amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(amountMinor);
  const whole = Math.trunc(absolute / 100);
  const cents = absolute % 100;
  return Number(`${sign}${whole}.${String(cents).padStart(2, '0')}`);
}

/** Decimal dollars back to minor units, rounded to the nearest cent. */
export function toMinorAmount(amount: number): Minor {
  return Math.round(amount * 100);
}

function authorisedMinor(response: ChargeResponse): Minor | null {
  const amount =
    response.auth_amount ??
    response.transaction?.amount_details?.amount ??
    response.amount_details?.amount;
  return typeof amount === 'number' ? toMinorAmount(amount) : null;
}

function occurredAt(response: ChargeResponse): Date {
  const created = response.transaction?.created_at;
  return created ? new Date(created) : new Date();
}

function declineReason(response: ChargeResponse): string | null {
  return response.error_message ?? response.error_details ?? response.status ?? null;
}

/** Digital Wallet Charge: an encrypted provider payload under `token`. */
function walletFields(source: PaymentSourceInput): Record<string, unknown> {
  return {
    // The provider names its wallet sources in lower case, without separators.
    source: source.walletProvider === 'APPLE_PAY' ? 'applepay' : 'googlepay',
    token: source.token,
    // Only a fallback for surcharge calculation: ignored when the encrypted
    // payload already discloses the card's funding source.
    ...(source.binType === undefined ? {} : { bin_type: source.binType }),
    ...(source.avsZip === undefined ? {} : { avs_zip: source.avsZip }),
    ...(source.avsAddress === undefined ? {} : { avs_address: source.avsAddress }),
  };
}
