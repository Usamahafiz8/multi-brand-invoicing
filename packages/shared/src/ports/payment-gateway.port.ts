/**
 * PaymentGatewayPort (TDD-001 §10.2).
 *
 * The domain depends on this interface; adapters implement it. That boundary is
 * what let the invoicing, calculation and state-machine work proceed against
 * FakeGateway while Numbers Gateway's contract was still unread (DEP-01, since
 * resolved), and it is what lets a second provider be added without the domain
 * learning a new vocabulary.
 *
 * Operations SHOULD be idempotent on `idempotencyKey`: a repeated call with the
 * same key returns the original intent rather than charging twice. FakeGateway
 * honours this exactly. Numbers Gateway does NOT — its API has no request-level
 * idempotency of any kind — so its adapter can only dedupe against calls it has
 * already seen in this process and must never blind-retry a charge whose
 * outcome it did not observe. Callers must treat a failed charge as
 * indeterminate and reconcile rather than retry.
 */

import type { CurrencyCode, Minor } from '../money/money.js';
import type { PaymentMethod } from '../money/calculation.js';

export const PAYMENT_INTENT_STATUSES = [
  'REQUIRES_ACTION',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
export type PaymentIntentStatus = (typeof PAYMENT_INTENT_STATUSES)[number];

/**
 * The instrument being charged, as a provider-side handle.
 *
 * Raw card data never appears here and never reaches our servers: `NONCE` is a
 * hosted-tokenization token minted by the gateway's own iframed fields, and
 * `WALLET` is the encrypted payload a wallet hands the page. Keeping the PAN
 * out of this type is what keeps the API inside PCI SAQ A scope.
 *
 * Optional because FakeGateway invents its own instrument; a real gateway
 * cannot charge without one and its adapter rejects the call.
 */
export interface PaymentSourceInput {
  readonly kind: 'NONCE' | 'WALLET' | 'STORED';
  /** Hosted-tokenization nonce, wallet payload, or stored-method reference. */
  readonly token: string;
  readonly walletProvider?: 'GOOGLE_PAY' | 'APPLE_PAY';
  /** Returned alongside a hosted-tokenization nonce; some gateways require it. */
  readonly expiryMonth?: number;
  readonly expiryYear?: number;
  readonly avsZip?: string;
  readonly avsAddress?: string;
  /** Card funding source, where the wallet discloses it. 'C'redit or 'D'ebit. */
  readonly binType?: 'C' | 'D';
}

export interface CreateIntentInput {
  /** Hash of (invoice id, amount, attempt nonce). See TDD-001 §8.3. */
  readonly idempotencyKey: string;
  readonly invoiceId: string;
  readonly brandId: string;
  readonly amountMinor: Minor;
  readonly currency: CurrencyCode;
  readonly method: PaymentMethod;
  readonly description: string;
  readonly customer: {
    readonly email: string | null;
    readonly name: string | null;
  };
  /** Where the gateway returns the customer after a redirect flow. */
  readonly returnUrl: string;
  /** The tokenized instrument to charge. See PaymentSourceInput. */
  readonly source?: PaymentSourceInput;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PaymentIntent {
  readonly gatewayReference: string;
  readonly status: PaymentIntentStatus;
  readonly amountMinor: Minor;
  readonly currency: CurrencyCode;
  /** Present when the customer must be redirected or a form must be hosted. */
  readonly actionUrl?: string | null;
  /** Client secret or hosted-field token, if the gateway uses one. */
  readonly clientToken?: string | null;
  /** Gateway's own timestamp, used for out-of-order webhook rejection. */
  readonly occurredAt: Date;
  readonly declineReason?: string | null;
  readonly raw?: unknown;
}

export interface CaptureInput {
  readonly gatewayReference: string;
  readonly amountMinor?: Minor;
  readonly idempotencyKey: string;
}

export interface RefundInput {
  readonly gatewayReference: string;
  readonly amountMinor: Minor;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

export interface RefundResult {
  readonly refundReference: string;
  readonly amountMinor: Minor;
  readonly status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
  readonly occurredAt: Date;
}

export const GATEWAY_EVENT_TYPES = [
  'PAYMENT_SUCCEEDED',
  'PAYMENT_FAILED',
  'PAYMENT_PENDING',
  'PAYMENT_CANCELLED',
  'REFUND_SUCCEEDED',
  'REFUND_FAILED',
  'UNKNOWN',
] as const;
export type GatewayEventType = (typeof GATEWAY_EVENT_TYPES)[number];

export interface GatewayWebhookEvent {
  readonly id: string;
  readonly type: GatewayEventType;
  readonly gatewayReference: string;
  readonly amountMinor: Minor | null;
  readonly currency: CurrencyCode | null;
  /**
   * The gateway's timestamp for the event, NOT receipt time. Gateways do not
   * guarantee ordered delivery, so this is compared against the last processed
   * event for the payment and anything older is discarded (NFR-INT-012).
   */
  readonly occurredAt: Date;
  readonly declineReason?: string | null;
  readonly raw: unknown;
}

export interface PaymentGatewayPort {
  readonly providerName: string;

  createIntent(input: CreateIntentInput): Promise<PaymentIntent>;
  capture(input: CaptureInput): Promise<PaymentIntent>;
  refund(input: RefundInput): Promise<RefundResult>;
  void(gatewayReference: string): Promise<PaymentIntent>;
  retrieve(gatewayReference: string): Promise<PaymentIntent>;

  /**
   * Verifies the webhook signature. Returns false rather than throwing, so an
   * unsigned probe is a 401 and not a 500.
   */
  verifySignature(payload: string | Buffer, headers: Readonly<Record<string, string>>): boolean;

  /** Parses a verified payload into the platform's event shape. */
  parseWebhook(payload: string | Buffer): GatewayWebhookEvent;
}

export const PAYMENT_GATEWAY_PORT = Symbol('PaymentGatewayPort');
