import { createHmac, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  IntegrationError,
  SUPPORTED_CURRENCIES,
  classifyHttpStatus,
  type CaptureInput,
  type CreateIntentInput,
  type CurrencyCode,
  type ErrorClass,
  type GatewayEventType,
  type GatewayWebhookEvent,
  type Minor,
  type PaymentGatewayPort,
  type PaymentIntent,
  type PaymentIntentStatus,
  type RefundInput,
  type RefundResult,
} from '@fenwick/shared';
import { ENV, type Env } from '../../config/env.js';

/**
 * StripeGatewayAdapter — Stripe Payment Intents API (2024-06-20 and later).
 *
 * Two properties of this provider make it materially safer than the Numbers
 * adapter sitting beside it, and both are worth stating because they invert
 * decisions that file had to make:
 *
 * 1. REQUEST-LEVEL IDEMPOTENCY IS REAL. Every money-moving call sends
 *    `Idempotency-Key`, and Stripe replays the original response for 24 hours
 *    rather than acting twice. A charge whose response we never saw is
 *    therefore TRANSIENT — safe to retry with the same key — not the
 *    indeterminate, reconcile-by-hand state a Numbers timeout leaves behind.
 * 2. AMOUNTS ARE ALREADY MINOR UNITS. Stripe's `amount` is an integer in the
 *    currency's smallest unit, which is exactly the domain's representation
 *    (TDD-001 §9.1). No conversion happens here, and none should be added.
 *
 * The API is form-encoded, not JSON, including on responses' request bodies —
 * nested fields use bracket notation (`metadata[invoice_id]=…`). See `encode`.
 *
 * Card data never reaches this process. Stripe.js collects it in Stripe's own
 * iframed Elements and returns a PaymentMethod id (`pm_…`), which is what
 * `source.token` carries here. That is what keeps the API inside PCI SAQ A.
 */

const DEFAULT_BASE_URL = 'https://api.stripe.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Rejects replayed webhooks. Stripe's own libraries default to five minutes;
 * matching that means a delivery delayed longer than this is dropped and
 * retried by Stripe rather than accepted out of a replay.
 */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** PaymentIntent.status → the platform's vocabulary. */
const STATUS_MAP: Record<string, PaymentIntentStatus> = {
  requires_payment_method: 'REQUIRES_ACTION',
  requires_confirmation: 'REQUIRES_ACTION',
  requires_action: 'REQUIRES_ACTION',
  processing: 'PROCESSING',
  // Authorised but not yet captured. PROCESSING rather than SUCCEEDED: the
  // money has not moved, and treating it as settled would mark an invoice paid
  // on an authorisation that can still expire.
  requires_capture: 'PROCESSING',
  succeeded: 'SUCCEEDED',
  canceled: 'CANCELLED',
};

/** Stripe error `type` → retry class. */
const ERROR_TYPE_MAP: Record<string, ErrorClass> = {
  card_error: 'VALIDATION',
  invalid_request_error: 'VALIDATION',
  authentication_error: 'AUTHENTICATION',
  rate_limit_error: 'TRANSIENT',
  api_error: 'TRANSIENT',
  api_connection_error: 'TRANSIENT',
  // Same key, different payload — the caller changed the request under a key
  // Stripe has already answered. Never a retry.
  idempotency_error: 'CONFLICT',
};

/**
 * Stripe accepts only this closed set on a refund. Anything the domain supplies
 * that is not one of them travels as metadata instead of being forced into a
 * bucket that would misreport why the money went back.
 */
const REFUND_REASONS = new Set(['duplicate', 'fraudulent', 'requested_by_customer']);

interface StripeError {
  readonly type?: string;
  readonly code?: string;
  readonly message?: string;
  readonly decline_code?: string;
  readonly payment_intent?: StripePaymentIntent;
}

interface StripePaymentIntent {
  readonly id?: string;
  readonly status?: string;
  readonly amount?: number;
  readonly amount_received?: number;
  readonly currency?: string;
  readonly client_secret?: string | null;
  readonly created?: number;
  readonly next_action?: {
    readonly redirect_to_url?: { readonly url?: string | null } | null;
  } | null;
  readonly last_payment_error?: StripeError | null;
  readonly latest_charge?: string | null;
}

interface StripeRefund {
  readonly id?: string;
  readonly amount?: number;
  readonly status?: string;
  readonly created?: number;
  readonly payment_intent?: string | null;
  readonly failure_reason?: string | null;
}

interface StripeEvent {
  readonly id?: string;
  readonly type?: string;
  readonly created?: number;
  readonly data?: { readonly object?: Record<string, unknown> };
}

@Injectable()
export class StripeGatewayAdapter implements PaymentGatewayPort {
  readonly providerName = 'stripe';

  private readonly logger = new Logger(StripeGatewayAdapter.name);

  constructor(@Inject(ENV) private readonly env: Env) {}

  /**
   * Creates and, when an instrument is supplied, confirms a PaymentIntent.
   *
   * Both of Stripe's flows are supported because the port allows `source` to be
   * absent:
   *   - WITH a source: confirmed here, server-side, and the returned status is
   *     the real outcome. This is the shape the Numbers adapter also has.
   *   - WITHOUT one: created unconfirmed and the client secret comes back as
   *     `clientToken`, for the browser to confirm against Stripe directly. The
   *     webhook is what settles it; nothing is charged by this call.
   */
  async createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    const currency = this.assertSupported(input.currency);

    const body: Record<string, unknown> = {
      amount: input.amountMinor,
      currency: currency.toLowerCase(),
      description: input.description.slice(0, 1000),
      // Both are searchable in the Stripe dashboard, so a payment can be traced
      // back to an invoice without consulting our database.
      metadata: {
        invoice_id: input.invoiceId,
        brand_id: input.brandId,
        ...(input.metadata ?? {}),
      },
      ...(input.customer.email ? { receipt_email: input.customer.email } : {}),
    };

    const source = input.source;
    if (source) {
      // Every instrument Stripe.js produces — card, Apple Pay, Google Pay,
      // a saved method — arrives as a PaymentMethod id, so all three source
      // kinds collapse to the same field. There is no separate wallet path.
      body['payment_method'] = source.token;
      body['confirm'] = true;
      body['return_url'] = input.returnUrl;
      // Without this, a redirect-based method could hand back a next_action the
      // payment page has no flow for. Card and wallet never need one.
      body['automatic_payment_methods'] = { enabled: true, allow_redirects: 'never' };
    } else {
      body['automatic_payment_methods'] = { enabled: true };
    }

    const intent = await this.request<StripePaymentIntent>(
      'POST',
      '/payment_intents',
      body,
      // Safe to replay: Stripe returns the original response for this key.
      { idempotencyKey: input.idempotencyKey },
    );

    return this.toIntent(intent, input.amountMinor, currency);
  }

  async capture(input: CaptureInput): Promise<PaymentIntent> {
    const intent = await this.request<StripePaymentIntent>(
      'POST',
      `/payment_intents/${encodeURIComponent(input.gatewayReference)}/capture`,
      input.amountMinor === undefined ? {} : { amount_to_capture: input.amountMinor },
      { idempotencyKey: input.idempotencyKey },
    );
    return this.toIntent(intent, input.amountMinor ?? intent.amount ?? 0);
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const reason = input.reason?.toLowerCase();
    const refund = await this.request<StripeRefund>(
      'POST',
      '/refunds',
      {
        payment_intent: input.gatewayReference,
        amount: input.amountMinor,
        ...(reason && REFUND_REASONS.has(reason) ? { reason } : {}),
        // Preserved verbatim when it is not one of Stripe's three, so the
        // operator's actual wording survives on the Stripe side.
        ...(input.reason && !REFUND_REASONS.has(reason ?? '')
          ? { metadata: { reason: input.reason.slice(0, 500) } }
          : {}),
      },
      { idempotencyKey: input.idempotencyKey },
    );

    const status = refundStatus(refund.status);
    if (status === 'FAILED') {
      throw new IntegrationError({
        message: 'Stripe declined the refund',
        errorClass: 'VALIDATION',
        provider: this.providerName,
        providerMessage: refund.failure_reason ?? undefined,
      });
    }

    return {
      refundReference: refund.id ?? '',
      amountMinor: refund.amount ?? input.amountMinor,
      status,
      occurredAt: unixToDate(refund.created),
    };
  }

  async void(gatewayReference: string): Promise<PaymentIntent> {
    const intent = await this.request<StripePaymentIntent>(
      'POST',
      `/payment_intents/${encodeURIComponent(gatewayReference)}/cancel`,
      {},
      // No idempotency key: cancel is already idempotent by outcome, and a
      // second call against a cancelled intent is an error we want to see
      // rather than a replayed success.
      {},
    );
    return this.toIntent(intent, intent.amount ?? 0);
  }

  async retrieve(gatewayReference: string): Promise<PaymentIntent> {
    const intent = await this.request<StripePaymentIntent>(
      'GET',
      `/payment_intents/${encodeURIComponent(gatewayReference)}`,
      undefined,
      {},
    );
    return this.toIntent(intent, intent.amount ?? 0);
  }

  /**
   * Stripe-Signature is `t=<unix>,v1=<hex hmac>[,v1=<hex hmac>…]`, where the
   * signed payload is `${t}.${rawBody}` — the timestamp is inside the MAC, so
   * it cannot be altered to defeat the freshness check below.
   *
   * Multiple v1 values appear while a secret is being rotated; any one matching
   * is a pass. The body must be the bytes as received, which is why the Nest app
   * is created with `rawBody: true`.
   */
  verifySignature(payload: string | Buffer, headers: Readonly<Record<string, string>>): boolean {
    const secret = this.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.error('STRIPE_WEBHOOK_SECRET is not configured; rejecting webhook');
      return false;
    }

    const header = headers['stripe-signature'] ?? headers['Stripe-Signature'];
    if (!header) return false;

    const { timestamp, signatures } = parseSignatureHeader(header);
    if (!timestamp || signatures.length === 0) return false;

    // Freshness first: a captured-and-replayed delivery carries a signature
    // that is still perfectly valid, so the timestamp is the only defence.
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - timestamp);
    if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) {
      this.logger.warn(`rejecting webhook signed ${ageSeconds}s ago (outside tolerance)`);
      return false;
    }

    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${payload.toString()}`)
      .digest('hex');

    return signatures.some((candidate) => safeEquals(candidate, expected));
  }

  parseWebhook(payload: string | Buffer): GatewayWebhookEvent {
    const event = JSON.parse(payload.toString()) as StripeEvent;
    const object = (event.data?.object ?? {}) as StripePaymentIntent &
      StripeRefund & { readonly payment_intent?: string | null; readonly object?: string };

    // Refund and charge events carry their own id, but the payment intent is
    // what the rest of the platform keys payments by — so that is what is
    // published as the gateway reference wherever the event exposes it.
    const reference =
      typeof object.payment_intent === 'string' && object.payment_intent.length > 0
        ? object.payment_intent
        : (object.id ?? '');

    const currency = object.currency?.toUpperCase();

    return {
      id: event.id ?? '',
      type: toEventType(event.type),
      gatewayReference: reference,
      amountMinor: typeof object.amount === 'number' ? object.amount : null,
      currency: isSupported(currency) ? currency : null,
      // Stripe's own timestamp, not receipt time — out-of-order deliveries are
      // discarded by comparing this against the last event processed.
      occurredAt: unixToDate(event.created),
      declineReason: object.last_payment_error?.message ?? object.failure_reason ?? null,
      raw: event,
    };
  }

  // --- Request plumbing ------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    options: { idempotencyKey?: string },
  ): Promise<T> {
    const { baseUrl, secretKey } = this.credentials();
    const encoded = body === undefined ? undefined : encode(body);

    // GET parameters go on the query string; Stripe accepts nothing else there.
    const url =
      method === 'GET' && encoded ? `${baseUrl}${path}?${encoded}` : `${baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          // Pinning the version means Stripe's own upgrades cannot silently
          // change the shape this adapter parses.
          'Stripe-Version': this.env.STRIPE_API_VERSION ?? '2024-06-20',
          'User-Agent': 'FenwickInvoicing/1.0 (+stripe-gateway-adapter)',
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        ...(method === 'GET' || encoded === undefined ? {} : { body: encoded }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      // TRANSIENT even for a charge, and that is the whole point of sending an
      // idempotency key: the retry either reaches Stripe for the first time or
      // replays the answer it already produced. Neither charges twice.
      throw new IntegrationError({
        message: `Stripe did not respond to ${method} ${path}`,
        errorClass: 'TRANSIENT',
        provider: this.providerName,
        cause,
      });
    }

    const text = await response.text();

    if (!response.ok) throw this.toError(method, path, response, text);

    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new IntegrationError({
        message: `Stripe returned a non-JSON body for ${method} ${path}`,
        errorClass: 'PERMANENT',
        provider: this.providerName,
        providerMessage: text.slice(0, 500),
        cause,
      });
    }
  }

  private toError(
    method: string,
    path: string,
    response: Response,
    text: string,
  ): IntegrationError {
    let error: StripeError = {};
    try {
      error = (JSON.parse(text) as { error?: StripeError }).error ?? {};
    } catch {
      // Non-JSON error body; the HTTP status still classifies it below.
    }

    // Stripe's own error type is more precise than the status code — a card
    // decline and a malformed request are both 402/400 but mean different
    // things to the retry policy.
    const errorClass = (error.type ? ERROR_TYPE_MAP[error.type] : undefined)
      ?? classifyHttpStatus(response.status);

    const retryAfter = Number(response.headers.get('retry-after'));

    return new IntegrationError({
      message: `Stripe rejected ${method} ${path} with ${response.status}`,
      errorClass,
      provider: this.providerName,
      providerMessage: error.message ?? text.slice(0, 1000),
      // decline_code is the issuer's reason and is strictly more useful than
      // the generic `code` when both are present.
      providerCode: error.decline_code ?? error.code,
      httpStatus: response.status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0
        ? { retryAfterMs: retryAfter * 1000 }
        : {}),
    });
  }

  private credentials(): { baseUrl: string; secretKey: string } {
    const secretKey = this.env.STRIPE_SECRET_KEY;

    // Configuration is validated at boot when the driver is selected; this
    // guard covers the case where the adapter is reached by another route.
    if (!secretKey) {
      throw new IntegrationError({
        message: 'Stripe is not configured (needs STRIPE_SECRET_KEY)',
        errorClass: 'AUTHENTICATION',
        provider: this.providerName,
      });
    }

    return {
      baseUrl: (this.env.STRIPE_API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, ''),
      secretKey,
    };
  }

  // --- Mapping ---------------------------------------------------------------

  private toIntent(
    intent: StripePaymentIntent,
    requestedMinor: Minor,
    fallbackCurrency?: CurrencyCode,
  ): PaymentIntent {
    const status = toStatus(intent);
    const currency = intent.currency?.toUpperCase();

    return {
      gatewayReference: intent.id ?? '',
      status,
      // amount_received is what actually settled; `amount` is what was asked
      // for. They diverge on a partial capture.
      amountMinor:
        status === 'SUCCEEDED' && typeof intent.amount_received === 'number'
          ? intent.amount_received
          : (intent.amount ?? requestedMinor),
      currency: isSupported(currency) ? currency : (fallbackCurrency ?? 'USD'),
      actionUrl: intent.next_action?.redirect_to_url?.url ?? null,
      // The browser needs this to confirm an intent created without a source.
      clientToken: intent.client_secret ?? null,
      occurredAt: unixToDate(intent.created),
      declineReason: intent.last_payment_error?.message ?? null,
      raw: intent,
    };
  }

  private assertSupported(currency: CurrencyCode): CurrencyCode {
    if (!isSupported(currency)) {
      throw new IntegrationError({
        message: `${currency} is not a supported currency`,
        errorClass: 'VALIDATION',
        provider: this.providerName,
      });
    }
    return currency;
  }
}

// --- Pure helpers ------------------------------------------------------------

/**
 * Stripe's form encoding. Nested objects use bracket notation and arrays use
 * indices — `{metadata: {a: 1}}` becomes `metadata[a]=1`. Written out rather
 * than pulled from a library because it is twenty lines and the alternative is
 * a dependency inside the PCI review surface.
 *
 * Undefined and null values are dropped: Stripe treats an empty string as an
 * instruction to clear a field, which is not what an absent value means.
 */
export function encode(value: Record<string, unknown>): string {
  const parts: string[] = [];

  const walk = (prefix: string, current: unknown): void => {
    if (current === undefined || current === null) return;

    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(`${prefix}[${index}]`, item));
      return;
    }
    if (typeof current === 'object') {
      for (const [key, nested] of Object.entries(current as Record<string, unknown>)) {
        walk(`${prefix}[${key}]`, nested);
      }
      return;
    }
    parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(current))}`);
  };

  for (const [key, nested] of Object.entries(value)) walk(key, nested);
  return parts.join('&');
}

export function toStatus(intent: StripePaymentIntent): PaymentIntentStatus {
  const status = intent.status ?? '';

  // `requires_payment_method` is the state an intent returns to after a failed
  // confirmation as well as the one it starts in. The error is what tells the
  // two apart, and calling a decline REQUIRES_ACTION would leave the payment
  // waiting for a customer who has already been turned down.
  if (status === 'requires_payment_method' && intent.last_payment_error) return 'FAILED';

  return STATUS_MAP[status] ?? 'PROCESSING';
}

function refundStatus(status: string | undefined): RefundResult['status'] {
  if (status === 'succeeded') return 'SUCCEEDED';
  if (status === 'failed' || status === 'canceled') return 'FAILED';
  return 'PENDING';
}

export function toEventType(type: string | undefined): GatewayEventType {
  switch (type) {
    case 'payment_intent.succeeded':
      return 'PAYMENT_SUCCEEDED';
    case 'payment_intent.payment_failed':
      return 'PAYMENT_FAILED';
    case 'payment_intent.processing':
    case 'payment_intent.requires_action':
    case 'payment_intent.amount_capturable_updated':
      return 'PAYMENT_PENDING';
    case 'payment_intent.canceled':
      return 'PAYMENT_CANCELLED';
    case 'charge.refunded':
    case 'refund.created':
    case 'refund.updated':
      return 'REFUND_SUCCEEDED';
    case 'charge.refund.updated':
    case 'refund.failed':
      return 'REFUND_FAILED';
    default:
      return 'UNKNOWN';
  }
}

/** `t=1699999999,v1=abc,v1=def` → the timestamp and every v1 candidate. */
export function parseSignatureHeader(header: string): {
  timestamp: number | null;
  signatures: string[];
} {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (!key || value === undefined) continue;
    if (key === 't') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  return { timestamp, signatures };
}

function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // Length check first: timingSafeEqual throws on a length mismatch.
  return left.length === right.length && timingSafeEqual(left, right);
}

function isSupported(currency: string | undefined): currency is CurrencyCode {
  return (
    currency !== undefined && (SUPPORTED_CURRENCIES as readonly string[]).includes(currency)
  );
}

/** Stripe timestamps are unix seconds. */
function unixToDate(seconds: number | undefined): Date {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : new Date();
}
