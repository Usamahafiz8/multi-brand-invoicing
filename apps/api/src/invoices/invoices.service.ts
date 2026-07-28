import { randomBytes } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Invoice, LineItem } from '@prisma/client';
import {
  calculate,
  evaluateTransition,
  isPublicScope,
  parseMinor,
  quantityFrom,
  type InvoiceDraftInput,
  type Scope,
} from '@fenwick/shared';
import { PrismaService } from '../infra/prisma/prisma.service.js';
import { QueueService } from '../infra/queue/queue.service.js';

export type InvoiceWithLines = Invoice & { lineItems: LineItem[] };

/**
 * FR-INV. Draft creation and issue only — edit, cancel and duplicate follow
 * once this slice is proven end to end. CalculationService (TDD-001 §9.4) is
 * the only place the totals are computed; this service never re-derives them.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async list(scope: Scope, brandId: string): Promise<InvoiceWithLines[]> {
    return this.prisma.withScope(scope, (tx) =>
      tx.invoice.findMany({
        where: { brandId },
        include: { lineItems: { orderBy: { position: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async findOne(scope: Scope, brandId: string, id: string): Promise<InvoiceWithLines> {
    const invoice = await this.prisma.withScope(scope, (tx) =>
      tx.invoice.findFirst({
        where: { id, brandId },
        include: { lineItems: { orderBy: { position: 'asc' } } },
      }),
    );
    if (!invoice) throw new NotFoundException('invoice not found');
    return invoice;
  }

  /**
   * Draft only. Rates and totals are computed once, here, with
   * paymentMethod: 'MANUAL' — the fee-exempt baseline that becomes "the
   * amount due" everywhere the invoice is shown before a payment method is
   * chosen (open question Q-01, FRS-001 §28.3). A card or wallet payment
   * quotes its own fee-inclusive total at payment time; see PublicInvoicesService.
   */
  async create(scope: Scope, brandId: string, input: InvoiceDraftInput): Promise<InvoiceWithLines> {
    return this.prisma.withScope(scope, async (tx) => {
      const customer = await tx.customer.findFirst({ where: { id: input.customerId, brandId } });
      if (!customer) throw new NotFoundException('customer not found for this brand');

      const calcLines = input.lines.map((line) => ({
        quantity: quantityFrom(line.quantity),
        unitPriceMinor: parseMinor(line.unitPrice, input.currency),
        taxExempt: line.taxExempt,
      }));

      const result = calculate({
        lines: calcLines,
        taxRateBp: input.taxRateBp,
        cardFeeRateBp: input.cardFeeRateBp,
        paymentMethod: 'MANUAL',
      });

      // Allocates the number under the brand_settings row lock: concurrent
      // creates for the same brand serialise on this UPDATE, which is what
      // keeps the sequence unique without a separate locking construct
      // (NFR-INT-014).
      const settings = await tx.brandSettings.update({
        where: { brandId },
        data: { nextSequence: { increment: 1 } },
        select: { invoicePrefix: true, nextSequence: true },
      });
      const number = `${settings.invoicePrefix}-${String(settings.nextSequence - 1).padStart(4, '0')}`;

      try {
        return await tx.invoice.create({
          data: {
            brandId,
            customerId: input.customerId,
            number,
            status: 'DRAFT',
            invoiceDate: input.invoiceDate,
            dueDate: input.dueDate,
            currency: input.currency,
            subtotalMinor: result.subtotalMinor,
            taxRateBpApplied: result.taxRateBpApplied,
            taxMinor: result.taxMinor,
            cardFeeRateBpApplied: result.cardFeeRateBpApplied,
            cardFeeMinor: 0,
            totalMinor: result.totalMinor,
            balanceMinor: result.totalMinor,
            publicToken: randomBytes(16).toString('hex'),
            notes: input.notes,
            internalNotes: input.internalNotes,
            // Zipped by index rather than a second lookup keyed by position:
            // result.lines and input.lines are guaranteed the same length and
            // order as calcLines (calculate() runs the identical .map over
            // these same lines), so an out-of-range read here would mean
            // calculate()'s own contract broke — worth a hard failure, not a
            // silently substituted default.
            lineItems: {
              create: calcLines.map((line, position) => {
                const source = input.lines[position];
                const computed = result.lines[position];
                if (!source || !computed) {
                  throw new Error(
                    `line ${position} missing after calculation — calculate() invariant violated`,
                  );
                }
                return {
                  position,
                  itemName: source.itemName,
                  description: source.description,
                  quantity: line.quantity,
                  unitPriceMinor: line.unitPriceMinor,
                  lineTotalMinor: computed.lineTotalMinor,
                  taxExempt: line.taxExempt,
                };
              }),
            },
          },
          include: { lineItems: { orderBy: { position: 'asc' } } },
        });
      } catch (error) {
        // The sequence lock above should make this unreachable; caught anyway
        // rather than asserting the exact constraint name Prisma generates.
        if (PrismaService.isUniqueViolation(error)) {
          throw new ConflictException('invoice number collision — retry');
        }
        throw error;
      }
    });
  }

  /** FR-INV-014: Draft → Sent. Financial fields become immutable from here. */
  async issue(scope: Scope, brandId: string, id: string): Promise<InvoiceWithLines> {
    const updated = await this.prisma.withScope(scope, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id, brandId },
        include: { lineItems: true, customer: true },
      });
      if (!invoice) throw new NotFoundException('invoice not found');

      const decision = evaluateTransition('ISSUE', {
        status: invoice.status,
        lineItemCount: invoice.lineItems.length,
        totalMinor: Number(invoice.totalMinor),
        balanceMinor: Number(invoice.balanceMinor),
        settledMinor: 0,
        customerHasDeliverableEmail: Boolean(invoice.customer.email),
      });
      if (!decision.ok) throw new ConflictException(decision.message);

      const updated = await tx.invoice.update({
        where: { id },
        data: { status: decision.to, issuedAt: new Date() },
        include: { lineItems: { orderBy: { position: 'asc' } } },
      });

      await tx.invoiceEvent.create({
        data: {
          invoiceId: id,
          eventType: 'ISSUE',
          fromStatus: invoice.status,
          toStatus: decision.to,
          actor: isPublicScope(scope) ? 'system' : scope.userId,
        },
      });

      return updated;
    });

    // Enqueued after commit — see CustomersService.create for why.
    await this.queue.enqueue('sync', 'zoho-push-invoice', { brandId, invoiceId: id });

    return updated;
  }
}
