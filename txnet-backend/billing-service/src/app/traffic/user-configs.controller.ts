import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { ConfigActionRefused } from './config-actions';
import { GrantUsageService } from './grant-usage';
import { UserConfigsService } from './user-configs';
import { ConfigActionBody, configActionSchema, ConfigLabelBody, configLabelSchema } from './user-configs.schema';

const E = BackendI18nKeys.errors.billing;

/**
 * A user's own configs (F-027-ac): the list under one Grant, and the actions
 * the user may take on them — `regenerate` and `retire`, on one config or up
 * to fifty.
 *
 * Whose configs is the gate's `X-User-Id`, never a field. Another user's Grant
 * is the same 404 as a missing one; another user's config is the same
 * `config_not_found` outcome, so neither route is a way to ask whether an id
 * exists.
 *
 * The capability is `subscriptionLink`, as on the Grant list: these are the
 * configs `/sub` serves, so they are open exactly when it is. The Grant's
 * 30-day usage (F-307-b) sits here too: it is read through the same configs,
 * behind the same ownership check.
 */
@Controller('billing/traffic')
export class UserConfigsController {
  constructor(
    private readonly configs: UserConfigsService,
    private readonly usageOf: GrantUsageService,
  ) {}

  @TenantCapability('subscriptionLink')
  @Get('grants/:grantId/configs')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.CONFIG_LIST, identityOf(req).userId),
    configKey: 'CONFIG_LIST_RATE_LIMIT',
    windowSec: 900,
  })
  async list(@Param('grantId', ParseUUIDPipe) grantId: string, @Req() req: Request) {
    try {
      const userId = identityOf(req).userId;
      const rows = await this.configs.listForGrant(userId, grantId);
      return { grantId, rows, regenerate: await this.configs.regenerateTerms(userId, grantId) };
    } catch (e) {
      if (e instanceof ConfigActionRefused && e.reason === 'grant_not_found') {
        throw new NotFoundException({ i18nKey: E.grant.notFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      throw e;
    }
  }

  /** The Grant's daily upload/download over the last 30 UTC days, today included (F-307-b). */
  @TenantCapability('subscriptionLink')
  @Get('grants/:grantId/usage')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.GRANT_USAGE, identityOf(req).userId),
    configKey: 'GRANT_USAGE_RATE_LIMIT',
    windowSec: 900,
  })
  async usage(@Param('grantId', ParseUUIDPipe) grantId: string, @Req() req: Request) {
    try {
      return { grantId, ...(await this.usageOf.dailyForGrant(identityOf(req).userId, grantId)) };
    } catch (e) {
      if (e instanceof ConfigActionRefused && e.reason === 'grant_not_found') {
        throw new NotFoundException({ i18nKey: E.grant.notFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      throw e;
    }
  }

  /** Always 200 with one outcome per config: a refusal of one is not a failure of the request (user, 2026-09-23). */
  @TenantCapability('subscriptionLink')
  @Post('configs/actions')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.CONFIG_ACTION, identityOf(req).userId),
    configKey: 'CONFIG_ACTION_RATE_LIMIT',
    windowSec: 900,
  })
  async act(@Body(new ZodValidationPipe(configActionSchema)) body: ConfigActionBody, @Req() req: Request) {
    return { action: body.action, results: await this.configs.act(identityOf(req).userId, body.action, body.configIds) };
  }

  /**
   * The buyer names one of their configs, or clears the name (F-307-g,
   * ADR-0089). Under `CONFIG_ACTION`: a write, and cheap to spend on naming.
   */
  @TenantCapability('subscriptionLink')
  @Put('configs/:configId/label')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.CONFIG_ACTION, identityOf(req).userId),
    configKey: 'CONFIG_ACTION_RATE_LIMIT',
    windowSec: 900,
  })
  async setLabel(
    @Param('configId', ParseUUIDPipe) configId: string,
    @Body(new ZodValidationPipe(configLabelSchema)) body: ConfigLabelBody,
    @Req() req: Request,
  ) {
    try {
      // The label as saved, in one spelling (F-307-o), not as sent.
      const label = await this.configs.setLabel(identityOf(req).userId, configId, body.label);
      return { configId, label };
    } catch (e) {
      if (e instanceof ConfigActionRefused && e.reason === 'config_not_found') {
        throw new NotFoundException({ i18nKey: E.configNotFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      throw e;
    }
  }
}
