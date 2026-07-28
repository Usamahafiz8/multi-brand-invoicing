import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type Customer } from '@prisma/client';
import type { CustomerInput, CustomerListQuery, Scope } from '@fenwick/shared';
import { PrismaService } from '../infra/prisma/prisma.service.js';
import { QueueService } from '../infra/queue/queue.service.js';

export interface CustomerListResult {
  readonly data: Customer[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

/**
 * Customers (FR-CUS). Every method runs inside PrismaService.withScope, which
 * is the only path to this table — row-level security is the backstop, this
 * is the layer that keeps a query from being attempted unscoped at all.
 *
 * "Not found" covers both "does not exist" and "exists but RLS hid it": the
 * two are indistinguishable on purpose (NFR-SEC-025 — no resource leakage).
 */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async list(scope: Scope, brandId: string, query: CustomerListQuery): Promise<CustomerListResult> {
    return this.prisma.withScope(scope, async (tx) => {
      const where: Prisma.CustomerWhereInput = { brandId };

      if (query.search) {
        const search = query.search;
        where.OR = [
          { displayName: { contains: search, mode: 'insensitive' } },
          { companyName: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
        ];
      }

      if (query.dateRange && (query.dateRange.from || query.dateRange.to)) {
        where.createdAt = {
          ...(query.dateRange.from ? { gte: query.dateRange.from } : {}),
          ...(query.dateRange.to ? { lte: query.dateRange.to } : {}),
        };
      }

      if (query.hasOutstanding !== undefined) {
        const outstandingClause: Prisma.InvoiceListRelationFilter = {
          [query.hasOutstanding ? 'some' : 'none']: {
            balanceMinor: { gt: 0n },
            status: { notIn: ['PAID', 'CANCELLED'] },
          },
        };
        where.invoices = outstandingClause;
      }

      const [data, total] = await Promise.all([
        tx.customer.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        tx.customer.count({ where }),
      ]);

      return { data, page: query.page, pageSize: query.pageSize, total };
    });
  }

  async findOne(scope: Scope, brandId: string, id: string): Promise<Customer> {
    const customer = await this.prisma.withScope(scope, (tx) =>
      tx.customer.findFirst({ where: { id, brandId } }),
    );
    if (!customer) throw new NotFoundException('customer not found');
    return customer;
  }

  async create(scope: Scope, brandId: string, input: CustomerInput): Promise<Customer> {
    const customer = await this.prisma.withScope(scope, async (tx) => {
      try {
        return await tx.customer.create({
          data: {
            brandId,
            type: input.type,
            salutation: input.salutation,
            firstName: input.firstName,
            lastName: input.lastName,
            companyName: input.companyName,
            displayName: input.displayName,
            email: input.email,
            phone: input.phone,
            billingAddress: input.billingAddress ?? Prisma.JsonNull,
            shippingAddress: input.shippingAddress ?? Prisma.JsonNull,
          },
        });
      } catch (error) {
        throw this.translateWriteError(error);
      }
    });

    // Enqueued after the transaction commits — a rollback above must never
    // leave a sync job pointing at a customer that does not exist.
    await this.queue.enqueue('sync', 'zoho-push-customer', { brandId, customerId: customer.id });

    return customer;
  }

  async update(scope: Scope, brandId: string, id: string, input: CustomerInput): Promise<Customer> {
    return this.prisma.withScope(scope, async (tx) => {
      const existing = await tx.customer.findFirst({ where: { id, brandId } });
      if (!existing) throw new NotFoundException('customer not found');

      try {
        return await tx.customer.update({
          where: { id },
          data: {
            type: input.type,
            salutation: input.salutation,
            firstName: input.firstName,
            lastName: input.lastName,
            companyName: input.companyName,
            displayName: input.displayName,
            email: input.email,
            phone: input.phone,
            billingAddress: input.billingAddress ?? Prisma.JsonNull,
            shippingAddress: input.shippingAddress ?? Prisma.JsonNull,
          },
        });
      } catch (error) {
        throw this.translateWriteError(error);
      }
    });
  }

  /**
   * Postgres reports a WITH CHECK failure as a bare "row-level security
   * policy" error, not a typed Prisma error — this is the only place that
   * text is inspected, and only to avoid leaking a raw SQL error to a client.
   */
  private translateWriteError(error: unknown): Error {
    if (PrismaService.isUniqueViolation(error)) {
      return new ConflictException('a customer with this identifier already exists');
    }
    if (error instanceof Error && /row-level security/i.test(error.message)) {
      return new ForbiddenException('insufficient permissions for this brand');
    }
    return error instanceof Error ? error : new Error(String(error));
  }
}
