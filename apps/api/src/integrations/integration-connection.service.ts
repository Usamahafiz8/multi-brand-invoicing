import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AccountingConnection, Scope } from '@fenwick/shared';
import { decryptCredential, encryptCredential } from '../common/credential-encryption.js';
import { ENV, type Env } from '../config/env.js';
import { PrismaService } from '../infra/prisma/prisma.service.js';
import { ZohoBooksAdapter } from '../adapters/accounting/zoho-books.adapter.js';

export interface ZohoCredentials {
  readonly refreshToken: string;
  readonly apiDomain: string;
}

export interface ZohoConnectionConfig {
  readonly organizationId: string;
  readonly organizationName: string;
}

export interface ZohoConnectionStatus {
  readonly connected: boolean;
  readonly organizationName: string | null;
  readonly lastSyncAt: Date | null;
  readonly health: string | null;
}

/**
 * Encrypted storage for the Zoho connection, plus the one piece of glue an
 * AccountingConnection always needs: a live access token, refreshed on every
 * use rather than cached (TDD-001 §10.4 chose correctness over an access-
 * token cache this scale does not need).
 */
@Injectable()
export class IntegrationConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ENV) private readonly env: Env,
    private readonly zoho: ZohoBooksAdapter,
  ) {}

  async saveZohoConnection(
    scope: Scope,
    brandId: string,
    credentials: ZohoCredentials,
    config: ZohoConnectionConfig,
  ): Promise<void> {
    const encrypted = encryptCredential(JSON.stringify(credentials), this.env.CREDENTIAL_ENCRYPTION_KEY);
    await this.prisma.withScope(scope, (tx) =>
      tx.integrationConnection.upsert({
        where: { brandId_provider: { brandId, provider: 'ZOHO_BOOKS' } },
        create: {
          brandId,
          provider: 'ZOHO_BOOKS',
          status: 'CONNECTED',
          encryptedCredentials: encrypted,
          config: config as unknown as Prisma.InputJsonValue,
          lastSyncAt: new Date(),
          health: 'Healthy',
        },
        update: {
          status: 'CONNECTED',
          encryptedCredentials: encrypted,
          config: config as unknown as Prisma.InputJsonValue,
          health: 'Healthy',
        },
      }),
    );
  }

  async getStatus(scope: Scope, brandId: string): Promise<ZohoConnectionStatus> {
    const row = await this.prisma.withScope(scope, (tx) =>
      tx.integrationConnection.findUnique({ where: { brandId_provider: { brandId, provider: 'ZOHO_BOOKS' } } }),
    );
    if (!row) return { connected: false, organizationName: null, lastSyncAt: null, health: null };
    const config = row.config as unknown as ZohoConnectionConfig | null;
    return {
      // A CONNECTED status with no stored credentials cannot actually reach
      // Zoho — buildAccountingConnection applies the same requirement — so
      // it must not be reported as connected here either.
      connected: row.status === 'CONNECTED' && Boolean(row.encryptedCredentials),
      organizationName: config?.organizationName ?? null,
      lastSyncAt: row.lastSyncAt,
      health: row.health,
    };
  }

  /**
   * A ready-to-use AccountingConnection for one call, with a freshly
   * refreshed access token. Returns null if the brand has never connected —
   * the caller decides whether that is "nothing to do" or an error.
   */
  async buildAccountingConnection(scope: Scope, brandId: string): Promise<AccountingConnection | null> {
    const row = await this.prisma.withScope(scope, (tx) =>
      tx.integrationConnection.findUnique({ where: { brandId_provider: { brandId, provider: 'ZOHO_BOOKS' } } }),
    );
    if (!row?.encryptedCredentials || row.status !== 'CONNECTED') return null;

    const credentials = JSON.parse(
      decryptCredential(row.encryptedCredentials, this.env.CREDENTIAL_ENCRYPTION_KEY),
    ) as ZohoCredentials;
    const config = row.config as unknown as ZohoConnectionConfig;

    const { accessToken, expiresAt } = await this.zoho.refreshAccessToken(credentials.refreshToken);

    return {
      brandId,
      organisationId: config.organizationId,
      accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt,
    };
  }

  async markUnhealthy(scope: Scope, brandId: string, reason: string): Promise<void> {
    await this.prisma.withScope(scope, (tx) =>
      tx.integrationConnection
        .update({
          where: { brandId_provider: { brandId, provider: 'ZOHO_BOOKS' } },
          data: { status: 'UNHEALTHY', health: reason },
        })
        // A brand that was never connected has no row to mark — nothing to do.
        .catch(() => undefined),
    );
  }

  async recordSyncRun(scope: Scope, brandId: string): Promise<void> {
    await this.prisma.withScope(scope, (tx) =>
      tx.integrationConnection.update({
        where: { brandId_provider: { brandId, provider: 'ZOHO_BOOKS' } },
        data: { lastSyncAt: new Date(), health: 'Healthy' },
      }),
    );
  }
}
