import { Module } from '@nestjs/common';
import { PAYMENT_GATEWAY_PORT } from '@fenwick/shared';
import { ENV, type Env } from '../../config/env.js';
import { FakeGatewayAdapter } from './fake-gateway.adapter.js';
import { NumbersGatewayAdapter } from './numbers-gateway.adapter.js';

/**
 * Composition point for PaymentGatewayPort. The driver is a configuration
 * value; nothing above this line knows which adapter is bound.
 */
@Module({
  providers: [
    FakeGatewayAdapter,
    NumbersGatewayAdapter,
    {
      provide: PAYMENT_GATEWAY_PORT,
      inject: [ENV, FakeGatewayAdapter, NumbersGatewayAdapter],
      useFactory: (env: Env, fake: FakeGatewayAdapter, numbers: NumbersGatewayAdapter) =>
        env.PAYMENT_GATEWAY_DRIVER === 'numbers' ? numbers : fake,
    },
  ],
  exports: [PAYMENT_GATEWAY_PORT, FakeGatewayAdapter],
})
export class GatewayModule {}
