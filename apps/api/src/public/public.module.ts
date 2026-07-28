import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module.js';
import { PublicInvoicesController } from './public-invoices.controller.js';
import { PublicInvoicesService } from './public-invoices.service.js';

@Module({
  imports: [PaymentsModule],
  controllers: [PublicInvoicesController],
  providers: [PublicInvoicesService],
})
export class PublicModule {}
