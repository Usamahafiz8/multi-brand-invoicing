import { Injectable } from '@nestjs/common';
import { evaluateTransition, formatQuantity, type PublicScope } from '@fenwick/shared';
import { PrismaService } from '../infra/prisma/prisma.service.js';

export interface PublicInvoiceView {
  number: string;
  status: string;
  currency: string;
  dueDate: string;
  totalMinor: number;
  balanceMinor: number;
  brand: { displayName: string; themeColor: string; logoUrl: string | null };
  lines: Array<{
    itemName: string;
    description: string | null;
    quantity: string;
    lineTotalMinor: number;
  }>;
  subtotalMinor: number;
  taxMinor: number;
  cardFeeRateBp: number;
  partialPaymentEnabled: boolean;
  /** FR-PAY-005 — which methods this brand actually offers. The payment page
   * must only render these; PaymentsService.createIntent enforces the same
   * list server-side regardless of what the client shows. */
  enabledMethods: {
    card: boolean;
    applePay: boolean;
    googlePay: boolean;
    ach: boolean;
    check: boolean;
  };
}

/**
 * Token → data, for the anonymous payment path (TDD-001 §12.1). The token
 * lookup is deliberately unscoped: which brand this belongs to is exactly
 * what it exists to discover, and public_token is a 128-bit random value —
 * possessing it is the only credential required (NFR-SEC-014).
 */
@Injectable()
export class PublicInvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Null covers both "no such token" and "deactivated" — deliberately
   * indistinguishable to the caller (TDD-001 §12.1 step 3). */
  async resolveScope(token: string): Promise<PublicScope | null> {
    const invoice = await this.prisma.withoutScope(
      'public token resolution — token possession is the credential (NFR-SEC-014)',
      (client) =>
        client.invoice.findUnique({
          where: { publicToken: token },
          select: { id: true, brandId: true, publicTokenActive: true, brand: { select: { merchantId: true } } },
        }),
    );
    if (!invoice || !invoice.publicTokenActive) return null;

    return {
      kind: 'PUBLIC',
      merchantId: invoice.brand.merchantId,
      brandId: invoice.brandId,
      invoiceId: invoice.id,
      sourceIp: null,
    };
  }

  async view(scope: PublicScope): Promise<PublicInvoiceView | null> {
    return this.prisma.withScope(scope, async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: scope.invoiceId },
        include: {
          lineItems: { orderBy: { position: 'asc' } },
          brand: { include: { settings: true } },
        },
      });
      if (!invoice) return null;

      // FIRST_VIEW fires once; the guard only allows it from SENT, so a
      // second retrieval is a no-op (TDD-001 §8.2).
      let effectiveStatus = invoice.status;
      if (invoice.status === 'SENT') {
        const decision = evaluateTransition('FIRST_VIEW', {
          status: 'SENT',
          lineItemCount: invoice.lineItems.length,
          totalMinor: Number(invoice.totalMinor),
          balanceMinor: Number(invoice.balanceMinor),
          settledMinor: 0,
          customerHasDeliverableEmail: true,
        });
        if (decision.ok) {
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { status: decision.to, firstViewedAt: new Date() },
          });
          await tx.invoiceEvent.create({
            data: {
              invoiceId: invoice.id,
              eventType: 'FIRST_VIEW',
              fromStatus: 'SENT',
              toStatus: decision.to,
              actor: 'system',
            },
          });
          effectiveStatus = decision.to;
        }
      }

      return {
        number: invoice.number,
        status: effectiveStatus,
        currency: invoice.currency,
        dueDate: invoice.dueDate.toISOString().slice(0, 10),
        totalMinor: Number(invoice.totalMinor),
        balanceMinor: Number(invoice.balanceMinor),
        brand: {
          displayName: invoice.brand.displayName,
          themeColor: invoice.brand.themeColor,
          logoUrl: null, // no asset pipeline wired up yet — logoKey exists, signed URLs do not
        },
        lines: invoice.lineItems.map((l) => ({
          itemName: l.itemName,
          description: l.description,
          quantity: formatQuantity(l.quantity),
          lineTotalMinor: Number(l.lineTotalMinor),
        })),
        subtotalMinor: Number(invoice.subtotalMinor),
        taxMinor: Number(invoice.taxMinor),
        cardFeeRateBp: invoice.cardFeeRateBpApplied,
        partialPaymentEnabled: invoice.brand.settings?.partialPaymentEnabled ?? false,
        enabledMethods: {
          card: invoice.brand.settings?.cardEnabled ?? false,
          applePay: invoice.brand.settings?.applePayEnabled ?? false,
          googlePay: invoice.brand.settings?.googlePayEnabled ?? false,
          ach: invoice.brand.settings?.achEnabled ?? false,
          check: invoice.brand.settings?.checkEnabled ?? false,
        },
      };
    });
  }
}
