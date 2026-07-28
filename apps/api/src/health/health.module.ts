import { Module } from '@nestjs/common';
import { AccountingModule } from '../adapters/accounting/accounting.module.js';
import { GatewayModule } from '../adapters/gateway/gateway.module.js';
import { StorageModule } from '../adapters/storage/storage.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [StorageModule, AccountingModule, GatewayModule],
  controllers: [HealthController],
})
export class HealthModule {}
