import { Injectable } from '@nestjs/common';
import type { Brand } from '@prisma/client';
import type { Scope } from '@fenwick/shared';
import { PrismaService } from '../infra/prisma/prisma.service.js';

/**
 * Read-only for now — FR-BRD create/edit is a separate, larger piece of work.
 * This exists so a brand-scoped screen (customers, invoices, ...) has
 * something to build a brand switcher from. Restricted to the BRANDS
 * permission (FRS-001 §3.3: Owner and Merchant Admin only) rather than a
 * lighter "my assignments" read, which is a deliberate follow-up, not an
 * oversight — see the note left for the reader in brands.controller.ts.
 */
@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  list(scope: Scope): Promise<Brand[]> {
    return this.prisma.withScope(scope, (tx) =>
      tx.brand.findMany({ orderBy: { createdAt: 'asc' } }),
    );
  }
}
