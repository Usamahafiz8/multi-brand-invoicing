import { Module } from '@nestjs/common';
import { GatewayModule } from '../adapters/gateway/gateway.module.js';
import { PaymentsService } from './payments.service.js';

@Module({
  imports: [GatewayModule],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
