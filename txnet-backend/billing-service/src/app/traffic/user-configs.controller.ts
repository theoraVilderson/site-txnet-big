import { Body, ConflictException, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey, TenantCapability, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ConfigActionRefused } from './config-actions';
import { GrantPeriodRefused, GrantPeriodService } from './grant-period';
import { GrantUsageService } from './grant-usage';
import { SelfMoveRefused, type SelfMoveRejection } from './self-move';
import { UserConfigsService } from './user-configs';
import { ConfigActionBody, configActionSchema, ConfigLabelBody, configLabelSchema, SelfMoveBody, selfMoveSchema } from './user-configs.schema';

const E = BackendI18nKeys.errors.billing;

/** Each self-move refusal as the user is told it (F-410-c); `not_a_target` is 404, the rest 409. */
const SELF_MOVE_KEYS: Record<SelfMoveRejection, string> = {
  move_disabled: E.selfMove.off,
  placed_by_group: E.selfMove.placedByGroup,
  move_cooldown: E.selfMove.cooldown,
  not_a_target: E.selfMove.notATarget,
};

/** A refusal of the move as its HTTP answer; anything that is not one is rethrown, not told. */
function selfMoveError(e: unknown): unknown {
  if (e instanceof SelfMoveRefused) {
    // The wait's end rides as a figure, as every per-day cap's does (`facts.nextAtMs`).
    const facts = e.nextMoveAt ? { facts: { nextAtMs: Date.parse(e.nextMoveAt) } } : {};
    const body = { i18nKey: SELF_MOVE_KEYS[e.reason], reason: e.reason, message: `${e.name}: ${e.message}`, ...facts };
    return e.reason === 'not_a_target' ? new NotFoundException(body) : new ConflictException(body);
  }
  if (!(e instanceof ConfigActionRefused)) return e;
  const payload = { reason: e.reason, message: `${e.name}: ${e.message}` };
  // A retired config is no longer the user's to move: the same 404 as a missing one.
  if (e.reason === 'config_not_found' || e.reason === 'config_retired') return new NotFoundException({ i18nKey: E.configNotFound, ...payload });
  if (e.reason === 'grant_not_active') return new ConflictException({ i18nKey: E.selfMove.notActive, ...payload });
  // config_changed, or a target retired since it was read: try again from a fresh list.
  return new ConflictException({ i18nKey: E.selfMove.changed, ...payload });
}

/**
 * A user's own configs (F-027-ac): the list under one Grant, and the action
 * the user may take on them — `regenerate`, on one config or up to fifty. No
 * `retire`: a user does not delete a config (F-027-ac1); a reseller's admin does.
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
    private readonly periodOf: GrantPeriodService,
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

  /**
   * A metered Grant's billing period (F-118-ai): this one and the last, bytes
   * and usage money, and what the balance covers. Under `GRANT_USAGE`: one
   * more read of the same kind, one per metered service on the page.
   */
  @TenantCapability('subscriptionLink')
  @Get('grants/:grantId/period')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.GRANT_USAGE, identityOf(req).userId),
    configKey: 'GRANT_USAGE_RATE_LIMIT',
    windowSec: 900,
  })
  async period(@Param('grantId', ParseUUIDPipe) grantId: string, @Req() req: Request) {
    try {
      return { grantId, ...(await this.periodOf.forGrant(identityOf(req).userId, grantId)) };
    } catch (e) {
      if (!(e instanceof GrantPeriodRefused)) throw e;
      const payload = { reason: e.reason, message: `${e.name}: ${e.message}` };
      if (e.reason === 'grant_not_found') throw new NotFoundException({ i18nKey: E.grant.notFound, ...payload });
      throw new ConflictException({ i18nKey: E.grant.notMetered, ...payload });
    }
  }

  /**
   * Where the user may move this config, and when (F-410-b): the panels its
   * product allows, by id and region, and `nextMoveAt`. Under `CONFIG_LIST`:
   * one more read of the user's configs.
   */
  @TenantCapability('subscriptionLink')
  @Get('configs/:configId/move-targets')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.CONFIG_LIST, identityOf(req).userId),
    configKey: 'CONFIG_LIST_RATE_LIMIT',
    windowSec: 900,
  })
  async moveTargets(@Param('configId', ParseUUIDPipe) configId: string, @Req() req: Request) {
    try {
      return await this.configs.moveTargets(identityOf(req).userId, configId);
    } catch (e) {
      // A retired config is no longer the user's to move: the same 404 as a missing one.
      if (e instanceof ConfigActionRefused && (e.reason === 'config_not_found' || e.reason === 'config_retired')) {
        throw new NotFoundException({ i18nKey: E.configNotFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      throw e;
    }
  }

  /**
   * The user moves this config to a panel `move-targets` offered (F-410-c):
   * at once, free, no approval. Answers the new config's id and region and the
   * next allowed move; its lines arrive by `network.grant.linksCaptured`.
   * Under `CONFIG_ACTION`: a write of the user's own config.
   */
  @TenantCapability('subscriptionLink')
  @Post('configs/:configId/move')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.CONFIG_ACTION, identityOf(req).userId),
    configKey: 'CONFIG_ACTION_RATE_LIMIT',
    windowSec: 900,
  })
  async move(@Param('configId', ParseUUIDPipe) configId: string, @Body(new ZodValidationPipe(selfMoveSchema)) body: SelfMoveBody, @Req() req: Request) {
    try {
      return await this.configs.move(identityOf(req).userId, configId, body.toPanelId);
    } catch (e) {
      throw selfMoveError(e);
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
