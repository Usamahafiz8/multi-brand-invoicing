import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { idSchema, invoiceDraftSchema, type InvoiceDraftInput, type Scope } from '@fenwick/shared';
import { zodPipe } from '../common/zod-validation.pipe.js';
import { CurrentScope, RequirePermission } from '../tenancy/authorisation.js';
import { InvoicesService, type InvoiceWithLines } from './invoices.service.js';

/** FR-INV. Nested under the brand, matching CustomersController's convention. */
@Controller('brands/:brandId/invoices')
export class InvoicesController {
  constructor(private readonly invoices: InvoicesService) {}

  @Get()
  @RequirePermission('INVOICES', 'READ')
  list(
    @CurrentScope() scope: Scope,
    @Param('brandId', zodPipe(idSchema)) brandId: string,
  ): Promise<InvoiceWithLines[]> {
    return this.invoices.list(scope, brandId);
  }

  @Get(':id')
  @RequirePermission('INVOICES', 'READ')
  findOne(
    @CurrentScope() scope: Scope,
    @Param('brandId', zodPipe(idSchema)) brandId: string,
    @Param('id', zodPipe(idSchema)) id: string,
  ): Promise<InvoiceWithLines> {
    return this.invoices.findOne(scope, brandId, id);
  }

  @Post()
  @RequirePermission('INVOICES', 'WRITE')
  create(
    @CurrentScope() scope: Scope,
    @Param('brandId', zodPipe(idSchema)) brandId: string,
    @Body(zodPipe(invoiceDraftSchema)) body: InvoiceDraftInput,
  ): Promise<InvoiceWithLines> {
    return this.invoices.create(scope, brandId, body);
  }

  @Post(':id/issue')
  @RequirePermission('INVOICE_SEND', 'WRITE')
  issue(
    @CurrentScope() scope: Scope,
    @Param('brandId', zodPipe(idSchema)) brandId: string,
    @Param('id', zodPipe(idSchema)) id: string,
  ): Promise<InvoiceWithLines> {
    return this.invoices.issue(scope, brandId, id);
  }
}
