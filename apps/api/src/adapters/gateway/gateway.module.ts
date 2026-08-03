import { Module } from '@nestjs/common';
import { PAYMENT_GATEWAY_PORT } from '@fenwick/shared';
import { ENV, type Env } from '../../config/env.js';
import { FakeGatewayAdapter } from './fake-gateway.adapter.js';
import { NumbersGatewayAdapter } from './numbers-gateway.adapter.js';
import { StripeGatewayAdapter } from './stripe-gateway.adapter.js';

/**
 * Composition point for PaymentGatewayPort. The driver is a configuration
 * value; nothing above this line knows which adapter is bound.
 *
 * Every adapter is instantiated regardless of the selection — they are inert
 * without a call, and constructing them all keeps a misconfigured driver a
 * boot-time failure in env.ts rather than a missing provider at first payment.
 */
@Module({
  providers: [
    FakeGatewayAdapter,
    NumbersGatewayAdapter,
    StripeGatewayAdapter,
    {
      provide: PAYMENT_GATEWAY_PORT,
      inject: [ENV, FakeGatewayAdapter, NumbersGatewayAdapter, StripeGatewayAdapter],
      useFactory: (
        env: Env,
        fake: FakeGatewayAdapter,
        numbers: NumbersGatewayAdapter,
        stripe: StripeGatewayAdapter,
      ) => {
        switch (env.PAYMENT_GATEWAY_DRIVER) {
          case 'numbers':
            return numbers;
          case 'stripe':
            return stripe;
          default:
            return fake;
        }
      },
    },
  ],
  exports: [PAYMENT_GATEWAY_PORT, FakeGatewayAdapter],
})
export class GatewayModule {}
