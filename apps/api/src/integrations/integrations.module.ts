import { Module } from '@nestjs/common';
import { AccountingModule } from '../adapters/accounting/accounting.module.js';
import { IntegrationConnectionService } from './integration-connection.service.js';
import { ZohoConnectController } from './zoho-connect.controller.js';
import { ZohoSyncService } from './zoho-sync.service.js';

@Module({
  imports: [AccountingModule],
  controllers: [ZohoConnectController],
  providers: [IntegrationConnectionService, ZohoSyncService],
  exports: [IntegrationConnectionService, ZohoSyncService],
})
export class IntegrationsModule {}
