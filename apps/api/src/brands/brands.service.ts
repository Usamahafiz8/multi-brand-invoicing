import { Injectable } from '@nestjs/common';
import type { Brand } from '@prisma/client';
import type { BrandInput, Scope } from '@fenwick/shared';
import { isPublicScope } from '@fenwick/shared';
import { PrismaService } from '../infra/prisma/prisma.service.js';

export interface CreateBrandInput extends BrandInput {
  readonly invoicePrefix: string;
}

/**
 * List is gated on BRANDS READ (FRS-001 §3.3: Owner and Merchant Admin only)
 * rather than a lighter "my assignments" read — that is a distinct
 * permission from "list every brand in the organisation" and deserves its
 * own resource/decision, not a quiet loosening of BRANDS; see the note left
 * for the reader in brands.controller.ts.
 *
 * Create always targets the calling user's own merchant — a brand has no
 * meaning outside the tenant that owns it, and nothing in this app lets one
 * merchant create a brand for another.
 */
@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  list(scope: Scope): Promise<Brand[]> {
    return this.prisma.withScope(scope, (tx) =>
      tx.brand.findMany({ orderBy: { createdAt: 'asc' } }),
    );
  }

  async create(scope: Scope, input: CreateBrandInput): Promise<Brand> {
    // A public (token-scoped) caller has no merchantId of its own to create
    // a brand under — this endpoint is never reachable that way today, but
    // the narrowing makes the invariant explicit rather than assumed.
    if (isPublicScope(scope)) {
      throw new Error('brand creation requires an authenticated merchant scope');
    }
    const { invoicePrefix, ...brandFields } = input;

    return this.prisma.withScope(scope, (tx) =>
      tx.brand.create({
        data: {
          merchantId: scope.merchantId,
          legalName: brandFields.legalName,
          displayName: brandFields.displayName,
          salesPerson: brandFields.salesPersonName,
          phone: brandFields.phone,
          email: brandFields.email,
          mailingAddress: brandFields.mailingAddress ?? undefined,
          billingAddress: brandFields.billingAddress ?? undefined,
          taxId: brandFields.taxId,
          currency: brandFields.currency,
          timezone: brandFields.timezone,
          themeColor: brandFields.themeColor,
          settings: { create: { invoicePrefix } },
        },
      }),
    );
  }
}
