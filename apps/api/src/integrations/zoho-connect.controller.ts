import { BadRequestException, Controller, Get, Inject, Logger, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { idSchema, type Scope } from '@fenwick/shared';
import { zodPipe } from '../common/zod-validation.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { ZohoBooksAdapter } from '../adapters/accounting/zoho-books.adapter.js';
import { CurrentScope, Public, RequirePermission } from '../tenancy/authorisation.js';
import { SystemScopeResolver } from '../tenancy/system-scope.js';
import { IntegrationConnectionService, type ZohoConnectionStatus } from './integration-connection.service.js';
import { signZohoState, verifyZohoState } from './zoho-oauth-state.js';
import { ZohoSyncService, type BackfillCounts } from './zoho-sync.service.js';

/**
 * FR-ZHO-001. The connect leg is authenticated and brand-scoped as normal;
 * the callback leg cannot be — Zoho's redirect is a fresh, unauthenticated
 * browser request — so it derives the brand from the signed state instead
 * (TDD-001 §12, same pattern as the public payment path: possession of a
 * signed token is the credential, not a session).
 */
@Controller()
export class ZohoConnectController {
  private readonly logger = new Logger(ZohoConnectController.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly zoho: ZohoBooksAdapter,
    private readonly connections: IntegrationConnectionService,
    private readonly systemScope: SystemScopeResolver,
    private readonly sync: ZohoSyncService,
  ) {}

  @Get('brands/:brandId/integrations/zoho/status')
  @RequirePermission('INTEGRATIONS', 'READ')
  status(
    @Param('brandId', zodPipe(idSchema)) brandId: string,
    @CurrentScope() scope: Scope,
  ): Promise<ZohoConnectionStatus> {
    return this.connections.getStatus(scope, brandId);
  }

  /**
   * FR-ZHO-013. Re-runnable on demand — enqueueBackfill only ever queues
   * records still missing a zoho*Id, so calling this again after the initial
   * connect (or after fixing a failed sync) is always safe.
   */
  @Post('brands/:brandId/integrations/zoho/backfill')
  @RequirePermission('INTEGRATIONS', 'WRITE')
  backfill(@Param('brandId', zodPipe(idSchema)) brandId: string): Promise<BackfillCounts> {
    return this.sync.enqueueBackfill(brandId);
  }

  @Get('brands/:brandId/integrations/zoho/connect')
  @RequirePermission('INTEGRATIONS', 'WRITE')
  connect(@Param('brandId', zodPipe(idSchema)) brandId: string, @Res() response: Response): void {
    const state = signZohoState(brandId, this.env.SESSION_SECRET);
    const url = new URL('/oauth/v2/auth', this.env.ZOHO_ACCOUNTS_DOMAIN);
    url.searchParams.set('client_id', this.env.ZOHO_CLIENT_ID ?? '');
    url.searchParams.set('redirect_uri', this.env.ZOHO_REDIRECT_URI ?? '');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'ZohoBooks.fullaccess.all');
    url.searchParams.set('access_type', 'offline'); // without this, no refresh_token comes back
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);
    response.redirect(url.toString());
  }

  @Get('integrations/zoho/callback')
  @Public()
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const adminUrl = this.env.ADMIN_PUBLIC_URL;

    if (error) {
      response.redirect(`${adminUrl}/settings/zoho?error=${encodeURIComponent(error)}`);
      return;
    }
    if (!code || !state) {
      throw new BadRequestException('missing code or state');
    }

    const verified = verifyZohoState(state, this.env.SESSION_SECRET);
    if (!verified) {
      response.redirect(`${adminUrl}/settings/zoho?error=invalid_or_expired_state`);
      return;
    }
    const { brandId } = verified;

    try {
      const tokens = await this.zoho.exchangeAuthorizationCode(code);
      const organizations = await this.zoho.listOrganizations(tokens.accessToken, tokens.apiDomain);

      if (organizations.length === 0) {
        response.redirect(`${adminUrl}/settings/zoho?brandId=${brandId}&error=no_organizations`);
        return;
      }
      // More than one organization on the authorizing account picks the
      // first rather than prompting — a real "choose your organization"
      // step is a UI addition, not a correctness gap, but is not built here.
      const organization = organizations[0]!;

      const scope = await this.systemScope.forBrand(brandId, 'zoho-oauth-callback');
      if (!scope) {
        response.redirect(`${adminUrl}/settings/zoho?error=unknown_brand`);
        return;
      }

      await this.connections.saveZohoConnection(
        scope,
        brandId,
        { refreshToken: tokens.refreshToken, apiDomain: tokens.apiDomain },
        { organizationId: organization.organizationId, organizationName: organization.name },
      );

      // Everything that existed before this connection is worth pushing too,
      // not just what happens from here on (FR-ZHO-013). Enqueuing is fast —
      // awaited so a failure here can still redirect with connected=1 rather
      // than silently losing it, but it must never block on the jobs
      // actually running.
      try {
        await this.sync.enqueueBackfill(brandId);
      } catch (backfillError) {
        this.logger.warn(
          `initial backfill enqueue failed for brand ${brandId}: ${backfillError instanceof Error ? backfillError.message : backfillError}`,
        );
      }

      response.redirect(`${adminUrl}/settings/zoho?brandId=${brandId}&connected=1`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      response.redirect(`${adminUrl}/settings/zoho?brandId=${brandId}&error=${encodeURIComponent(message)}`);
    }
  }
}
