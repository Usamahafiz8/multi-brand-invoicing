import { Body, Controller, Get, Post } from '@nestjs/common';
import type { Brand } from '@prisma/client';
import { brandSchema, brandSettingsSchema, type Scope } from '@fenwick/shared';
import { zodPipe } from '../common/zod-validation.pipe.js';
import { CurrentScope, RequirePermission } from '../tenancy/authorisation.js';
import { BrandsService, type CreateBrandInput } from './brands.service.js';

/**
 * NOTE for whoever builds brand-scoped screens for Brand Admin / Finance /
 * Sales / Read Only next: this list is gated on BRANDS READ, which per the
 * FRS-001 §3.3 matrix only Owner and Merchant Admin hold. Those roles need a
 * lighter "brands I am assigned to" read to drive their own brand switcher —
 * that is a distinct permission from "list every brand in the organisation"
 * and deserves its own resource/decision, not a quiet loosening of BRANDS.
 */
const createBrandSchema = brandSchema.extend({
  invoicePrefix: brandSettingsSchema.shape.invoicePrefix,
});

@Controller('brands')
export class BrandsController {
  constructor(private readonly brands: BrandsService) {}

  @Get()
  @RequirePermission('BRANDS', 'READ', { brandFrom: 'none' })
  list(@CurrentScope() scope: Scope): Promise<Brand[]> {
    return this.brands.list(scope);
  }

  @Post()
  @RequirePermission('BRANDS', 'WRITE', { brandFrom: 'none' })
  create(
    @CurrentScope() scope: Scope,
    @Body(zodPipe(createBrandSchema)) body: CreateBrandInput,
  ): Promise<Brand> {
    return this.brands.create(scope, body);
  }
}
