import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Payment } from '@prisma/client';
import {
  IntegrationError,
  PAYMENT_GATEWAY_PORT,
  calculate,
  evaluateTransition,
  type CurrencyCode,
  type InvoiceStatus,
  type PaymentGatewayPort,
  type PaymentIntentStatus,
  type PaymentMethod,
  type PublicScope,
} from '@fenwick/shared';
import { ENV, type Env } from '../config/env.js';
import { PrismaService, type ScopedClient } from '../infra/prisma/prisma.service.js';
import { QueueService } from '../infra/queue/queue.service.js';

export interface PaymentAttemptResult {
  readonly gatewayStatus: PaymentIntentStatus;
  readonly invoiceStatus: InvoiceStatus;
  readonly declineReason: string | null;
}

/**
 * Payment intent creation and settlement (FR-PAY, TDD-001 §8.3).
 *
 * FakeGateway resolves success and decline synchronously — there is no
 * webhook round trip to wait for in those cases, so settlement is applied
 * immediately in the same request. `handleWebhook` exists for the pending
 * case and for a real gateway that settles asynchronously; it shares the
 * same settlement path so the two can never disagree about what "settled"
 * means.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    @Inject(PAYMENT_GATEWAY_PORT) private readonly gateway: PaymentGatewayPort,
    private readonly queue: QueueService,
  ) {}

  async createIntent(
    scope: PublicScope,
    method: PaymentMethod,
    attemptNonce: string,
  ): Promise<PaymentAttemptResult> {
    const outcome = await this.prisma.withScope(scope, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: scope.invoiceId },
        include: { lineItems: { orderBy: { position: 'asc' } }, customer: { select: { email: true } } },
      });
      if (!invoice) throw new BadRequestException('invoice not found');

      // FR-PAY-005: enforced here, not just hidden in the UI — the method
      // list a client sends is never trusted on its own.
      const settings = await tx.brandSettings.findUnique({ where: { brandId: invoice.brandId } });
      if (!settings || !this.isMethodEnabled(method, settings)) {
        throw new ConflictException(`${method} is not enabled for this brand`);
      }

      // Quotes THIS attempt's total for the chosen method (TDD-001 §9.4) — the
      // card fee applies here, never to the invoice's own stored total.
      const quote = calculate({
        lines: invoice.lineItems.map((l) => ({
          quantity: l.quantity,
          unitPriceMinor: Number(l.unitPriceMinor),
          taxExempt: l.taxExempt,
        })),
        taxRateBp: invoice.taxRateBpApplied,
        cardFeeRateBp: invoice.cardFeeRateBpApplied,
        paymentMethod: method,
      });
      const chargeMinor = quote.totalMinor;

      const idempotencyKey = createHash('sha256')
        .update(`${invoice.id}:${chargeMinor}:${attemptNonce}`)
        .digest('hex');

      const existing = await tx.payment.findUnique({ where: { idempotencyKey } });
      if (existing) {
        // A replay of an already-recorded attempt — whatever sync it needed
        // was already enqueued the first time it settled.
        return {
          result: {
            gatewayStatus: this.paymentStatusToIntentStatus(existing.status),
            invoiceStatus: invoice.status,
            declineReason: existing.declineReason,
          },
          sync: null,
        };
      }

      const originalStatus = invoice.status;
      const initDecision = evaluateTransition('INITIATE_PAYMENT', {
        status: invoice.status,
        lineItemCount: invoice.lineItems.length,
        totalMinor: Number(invoice.totalMinor),
        balanceMinor: Number(invoice.balanceMinor),
        settledMinor: 0,
        customerHasDeliverableEmail: Boolean(invoice.customer.email),
      });
      if (!initDecision.ok) throw new ConflictException(initDecision.message);

      const payment = await tx.payment.create({
        data: {
          invoiceId: invoice.id,
          brandId: invoice.brandId,
          method,
          amountMinor: chargeMinor,
          currency: invoice.currency,
          status: 'INITIATED',
          idempotencyKey,
        },
      });

      // previousStatus records where to revert on a definitive decline
      // (TDD-001 §8.2) — the status this invoice was in before this attempt,
      // not after.
      await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: initDecision.to, previousStatus: originalStatus },
      });

      let gatewayResult;
      try {
        gatewayResult = await this.gateway.createIntent({
          idempotencyKey,
          invoiceId: invoice.id,
          brandId: invoice.brandId,
          amountMinor: chargeMinor,
          // Persisted only through currencySchema-validated writes, so this
          // narrowing reflects a real invariant rather than an unchecked cast.
          currency: invoice.currency as CurrencyCode,
          method,
          description: `Invoice ${invoice.number}`,
          customer: { email: invoice.customer.email, name: null },
          returnUrl: `${this.env.PAYMENT_PUBLIC_URL}/i/${invoice.publicToken}`,
        });
      } catch (error) {
        // Transient (e.g. simulated timeout): the invoice stays in
        // PENDING_PAYMENT so the customer can retry; nothing is settled.
        if (error instanceof IntegrationError) {
          this.logger.warn(`gateway createIntent failed: ${error.message}`);
          throw new ConflictException(
            'The payment could not be started. Please try again in a moment.',
          );
        }
        throw error;
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: { gatewayReference: gatewayResult.gatewayReference },
      });

      await this.applySettlement(tx, {
        invoiceId: invoice.id,
        paymentId: payment.id,
        invoiceTotalMinor: Number(invoice.totalMinor),
        invoiceStatusBeforeAttempt: originalStatus,
        currentInvoiceStatus: initDecision.to,
        gatewayStatus: gatewayResult.status,
        occurredAt: gatewayResult.occurredAt,
        declineReason: gatewayResult.declineReason ?? null,
      });

      const finalInvoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
      return {
        result: {
          gatewayStatus: gatewayResult.status,
          invoiceStatus: finalInvoice.status,
          declineReason: gatewayResult.declineReason ?? null,
        },
        sync: gatewayResult.status === 'SUCCEEDED' ? { brandId: invoice.brandId, paymentId: payment.id } : null,
      };
    });

    // Enqueued after the transaction commits — see CustomersService.create.
    if (outcome.sync) {
      await this.queue.enqueue('sync', 'zoho-push-payment', outcome.sync);
    }
    return outcome.result;
  }

  /**
   * Webhook receiver for the async path (TDD-001 §8.2, NFR-PRF-022). Not
   * exercised by FakeGateway's success/decline scenarios, which resolve
   * synchronously in createIntent above — this exists for the pending
   * scenario and for a real gateway that settles out of band.
   */
  async handleWebhook(rawBody: Buffer, headers: Readonly<Record<string, string>>): Promise<void> {
    if (!this.gateway.verifySignature(rawBody, headers)) {
      throw new BadRequestException('invalid webhook signature');
    }
    const event = this.gateway.parseWebhook(rawBody);

    // Resolution by gateway reference is unscoped on purpose: which brand this
    // payment belongs to is exactly what this lookup exists to discover, and
    // gatewayReference is a provider-issued opaque id, not client-guessable
    // (TDD-001 §12.1). Every write that follows goes through withScope below.
    const payment = await this.prisma.withoutScope(
      'webhook resolution by gateway reference — the scope this event belongs to is not yet known',
      (client) =>
        client.payment.findUnique({
          where: { gatewayReference: event.gatewayReference },
          include: { invoice: { include: { brand: { select: { merchantId: true } } } } },
        }),
    );
    if (!payment) {
      this.logger.warn(`webhook for unknown gateway reference ${event.gatewayReference}`);
      return;
    }

    // Out-of-order delivery discard (NFR-INT-012): nothing older than the
    // last processed event for this payment is applied.
    if (payment.lastEventAt && event.occurredAt.getTime() <= payment.lastEventAt.getTime()) {
      this.logger.debug(`discarding stale event for payment ${payment.id}`);
      return;
    }

    const { invoice } = payment;
    const scope: PublicScope = {
      kind: 'PUBLIC',
      merchantId: invoice.brand.merchantId,
      brandId: invoice.brandId,
      invoiceId: invoice.id,
      sourceIp: null,
    };

    const gatewayStatus: PaymentIntentStatus =
      event.type === 'PAYMENT_SUCCEEDED'
        ? 'SUCCEEDED'
        : event.type === 'PAYMENT_FAILED'
          ? 'FAILED'
          : 'PROCESSING';

    await this.prisma.withScope(scope, (tx) =>
      this.applySettlement(tx, {
        invoiceId: invoice.id,
        paymentId: payment.id,
        invoiceTotalMinor: Number(invoice.totalMinor),
        invoiceStatusBeforeAttempt: invoice.previousStatus ?? invoice.status,
        currentInvoiceStatus: invoice.status,
        gatewayStatus,
        occurredAt: event.occurredAt,
        declineReason: event.declineReason ?? null,
      }),
    );

    if (gatewayStatus === 'SUCCEEDED') {
      await this.queue.enqueue('sync', 'zoho-push-payment', { brandId: invoice.brandId, paymentId: payment.id });
    }
  }

  /**
   * The one place a gateway result becomes an invoice/payment state change.
   * Called from both the synchronous path and the webhook path so they
   * cannot disagree about what "settled" means (NFR-INT-010..012).
   */
  private async applySettlement(
    tx: ScopedClient,
    input: {
      invoiceId: string;
      paymentId: string;
      invoiceTotalMinor: number;
      invoiceStatusBeforeAttempt: InvoiceStatus;
      currentInvoiceStatus: InvoiceStatus;
      gatewayStatus: PaymentIntentStatus;
      occurredAt: Date;
      declineReason: string | null;
    },
  ): Promise<void> {
    const { invoiceId, paymentId, invoiceTotalMinor, gatewayStatus, occurredAt, declineReason } = input;
    // SETTLE_FULL and PAYMENT_FAILED do not gate on line count; only ISSUE
    // does. Passed as 0 here rather than threading it through unused.
    const lineItemCount = 0;

    if (gatewayStatus === 'SUCCEEDED') {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'SETTLED', settledAt: occurredAt, lastEventAt: occurredAt },
      });

      const decision = evaluateTransition('SETTLE_FULL', {
        status: input.currentInvoiceStatus,
        lineItemCount,
        totalMinor: invoiceTotalMinor,
        balanceMinor: 0,
        settledMinor: invoiceTotalMinor,
        customerHasDeliverableEmail: true,
      });
      if (!decision.ok) {
        this.logger.error(`SETTLE_FULL refused for invoice ${invoiceId}: ${decision.message}`);
        return;
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: decision.to, balanceMinor: 0, paidAt: occurredAt, previousStatus: null },
      });
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          eventType: 'PAYMENT_SETTLED',
          fromStatus: input.currentInvoiceStatus,
          toStatus: decision.to,
          actor: 'system',
        },
      });
      return;
    }

    if (gatewayStatus === 'FAILED') {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: 'FAILED', declineReason, lastEventAt: occurredAt },
      });

      const decision = evaluateTransition('PAYMENT_FAILED', {
        status: input.currentInvoiceStatus,
        previousStatus: input.invoiceStatusBeforeAttempt,
        lineItemCount,
        totalMinor: invoiceTotalMinor,
        balanceMinor: invoiceTotalMinor,
        settledMinor: 0,
        customerHasDeliverableEmail: true,
      });
      if (!decision.ok) {
        this.logger.error(`PAYMENT_FAILED refused for invoice ${invoiceId}: ${decision.message}`);
        return;
      }

      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: decision.to, previousStatus: null },
      });
      await tx.invoiceEvent.create({
        data: {
          invoiceId,
          eventType: 'PAYMENT_FAILED',
          fromStatus: input.currentInvoiceStatus,
          toStatus: decision.to,
          actor: 'system',
          payload: declineReason ? { declineReason } : undefined,
        },
      });
      return;
    }

    // PROCESSING: invoice already sits in PENDING_PAYMENT from createIntent;
    // nothing changes until a later webhook reports a terminal status.
    await tx.payment.update({
      where: { id: paymentId },
      data: { status: 'PROCESSING', lastEventAt: occurredAt },
    });
  }

  /** Approximates a stored Payment row's status as an intent status for the
   * idempotent-replay fast path. INITIATED/CANCELLED map to PROCESSING as a
   * safe default — a client retrying with the same nonce this soon after
   * either of those is not a case the UI needs to distinguish precisely. */
  private paymentStatusToIntentStatus(status: Payment['status']): PaymentIntentStatus {
    switch (status) {
      case 'SETTLED':
      case 'PARTIALLY_REFUNDED':
      case 'REFUNDED':
        return 'SUCCEEDED';
      case 'FAILED':
        return 'FAILED';
      default:
        return 'PROCESSING';
    }
  }

  /**
   * FR-PAY-005. WALLET is one PaymentMethod value at this layer but two
   * separately-enabled toggles at the brand level (Apple Pay and Google Pay
   * have distinct real-world merchant registrations) — a WALLET attempt is
   * permitted if either is on. Distinguishing which wallet the customer
   * actually used would need its own field once real wallet integration
   * lands; nothing today produces that distinction to enforce against.
   */
  private isMethodEnabled(
    method: PaymentMethod,
    settings: { cardEnabled: boolean; applePayEnabled: boolean; googlePayEnabled: boolean; achEnabled: boolean; checkEnabled: boolean },
  ): boolean {
    switch (method) {
      case 'CARD':
        return settings.cardEnabled;
      case 'WALLET':
        return settings.applePayEnabled || settings.googlePayEnabled;
      case 'ACH':
        return settings.achEnabled;
      case 'CHECK':
        return settings.checkEnabled;
      case 'MANUAL':
        return true; // internal recording of an offline payment, not a customer choice
    }
  }
}
