import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { z } from 'zod';
import { paymentIntentRequestSchema, publicTokenSchema } from '@fenwick/shared';
import { zodPipe } from '../common/zod-validation.pipe.js';
import { Public } from '../tenancy/authorisation.js';
import { PaymentsService, type PaymentAttemptResult } from '../payments/payments.service.js';
import { PublicInvoicesService, type PublicInvoiceView } from './public-invoices.service.js';

const createIntentBodySchema = paymentIntentRequestSchema.pick({
  method: true,
  attemptNonce: true,
  source: true,
});
type CreateIntentBody = z.infer<typeof createIntentBodySchema>;

/**
 * The anonymous payment path (TDD-001 §12.1). Every route here is @Public();
 * the token is the only credential, and every failure mode — unknown token,
 * deactivated token, wrong brand — collapses to the same 404 so the endpoint
 * cannot be used to probe which invoices exist.
 */
@Controller('public')
export class PublicInvoicesController {
  constructor(
    private readonly publicInvoices: PublicInvoicesService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('invoices/:token')
  @Public()
  async view(
    @Param('token', zodPipe(publicTokenSchema)) token: string,
  ): Promise<PublicInvoiceView> {
    const scope = await this.publicInvoices.resolveScope(token);
    if (!scope) throw new NotFoundException('this payment link is no longer valid');

    const view = await this.publicInvoices.view(scope);
    if (!view) throw new NotFoundException('this payment link is no longer valid');
    return view;
  }

  @Post('invoices/:token/payment-intents')
  @Public()
  async createIntent(
    @Param('token', zodPipe(publicTokenSchema)) token: string,
    @Body(zodPipe(createIntentBodySchema)) body: CreateIntentBody,
  ): Promise<PaymentAttemptResult> {
    const scope = await this.publicInvoices.resolveScope(token);
    if (!scope) throw new NotFoundException('this payment link is no longer valid');

    return this.payments.createIntent(scope, body.method, body.attemptNonce, body.source);
  }

  @Post('webhooks/fake-gateway')
  @Public()
  @HttpCode(200)
  async fakeGatewayWebhook(@Req() request: RawBodyRequest<Request>): Promise<{ received: true }> {
    if (!request.rawBody) {
      throw new BadRequestException('missing request body');
    }
    await this.payments.handleWebhook(request.rawBody, request.headers as Record<string, string>);
    return { received: true };
  }
}
