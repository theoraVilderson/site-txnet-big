import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { EntitlementRefused, EntitlementRejection } from '../../entitlement/grant';
import { ConfigActionRefused } from '../../traffic/config-actions';
import type { AdminConfigCommand } from '../../traffic/user-configs';
import { AdminConfigActionBody, adminConfigActionSchema } from '../../traffic/user-configs.schema';
import { GrantDurationBody, grantDurationSchema } from './grant-duration.schema';
import { GrantFreezeBody, grantFreezeSchema } from './grant-freeze.schema';
import { GrantListQuery, grantListSchema } from './grant-list.schema';
import { bytesOfGb, GrantTrafficBody, grantTrafficSchema } from './grant-traffic.schema';
import {
  ResellerUserGrantsRefused,
  ResellerUserGrantsRejection,
  ResellerUserGrantsService,
} from './reseller-user-grants.service';

const E = BackendI18nKeys.errors.billing;

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerUserGrantsRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  user_not_found: 404,
};

/** A freeze's (F-311-h), a change of days' (F-311-i) and of traffic's (F-311-j) refusals; any other `EntitlementRefused` is not this surface's and passes through. */
const GRANT_ACTION_STATUS: Partial<Record<EntitlementRejection, 400 | 409>> = {
  grant_not_active: 409,
  grant_not_frozen: 409,
  grant_moved: 409,
  freeze_until_not_future: 400,
  grant_closed: 409,
  grant_permanent: 409,
  duration_end_not_future: 400,
  duration_unchanged: 400,
  traffic_not_adjustable: 409,
  quota_below_zero: 400,
};

/** One bucket for all four: expanding one Grant asks three of them at once. */
const readLimit = RateLimit({
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_GRANTS_READ, identityOf(req).userId),
  configKey: 'RESELLER_USER_GRANTS_READ_RATE_LIMIT',
  windowSec: 900,
});

/** Per request, not per config: one request is 1..50 configs. */
const actionLimit = RateLimit({
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_CONFIG_ACTION, identityOf(req).userId),
  configKey: 'RESELLER_USER_CONFIG_ACTION_RATE_LIMIT',
  windowSec: 900,
});

/**
 * An admin reads one user's services (F-311-f): the owner's four reads —
 * Grant list, a Grant's configs, its 30-day usage, its `/sub` link — for a
 * user of the reseller the **path** names. The data half of the panel's and
 * the bot's user sheet (F-311-v, F-311-y). And their config actions
 * (F-311-g): regenerate, disable, enable, retire, move — 1..50 ids, one
 * outcome per id, always 200, as on the owner's route.
 *
 * **No permission guard**, as on every reseller-named surface: `ResellerAccess`
 * is the door, inside the service. **The tenant is the path's**: the owner's
 * session carries the platform's `X-Tenant-Id` (ADR-0059).
 */
@Controller('billing/tenants/:tenantId/users/:userId')
export class ResellerUserGrantsController {
  constructor(private readonly service: ResellerUserGrantsService) {}

  @Get('grants')
  @readLimit
  grants(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query(new ZodValidationPipe(grantListSchema)) query: GrantListQuery,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.service.grants(actorOf(req), tenantId, userId, query));
  }

  @Get('grants/:grantId/configs')
  @readLimit
  async configs(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Req() req: Request,
  ) {
    return { grantId, rows: await this.refusing(() => this.service.configs(actorOf(req), tenantId, userId, grantId)) };
  }

  @Get('grants/:grantId/usage')
  @readLimit
  async usage(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Req() req: Request,
  ) {
    return { grantId, ...(await this.refusing(() => this.service.usage(actorOf(req), tenantId, userId, grantId))) };
  }

  /** Read only: resetting the link is an admin action of its own (F-311-n). */
  @Get('grants/:grantId/subscription-link')
  @readLimit
  async subscriptionLink(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Req() req: Request,
  ) {
    const subscriptionUrl = await this.refusing(() => this.service.subscriptionLink(actorOf(req), tenantId, userId, grantId));
    return { grantId, subscriptionUrl };
  }

  /** Always 200 with one outcome per config; a refusal of the door, the user or the body is the request's. */
  @Post('configs/actions')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async act(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(adminConfigActionSchema)) body: AdminConfigActionBody,
    @Req() req: Request,
  ) {
    return { action: body.action, results: await this.refusing(() => this.service.act(actorOf(req), tenantId, userId, body as AdminConfigCommand)) };
  }

  /**
   * An admin freezes one of this user's Grants (F-311-h): its configs off, its
   * clock stopped, kept — never purged. `until` unfreezes it by itself.
   * The config actions' bucket: both are an admin's writes on a user's service.
   */
  @Post('grants/:grantId/freeze')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async freeze(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantFreezeSchema)) body: GrantFreezeBody,
    @Req() req: Request,
  ) {
    const until = body.until ? new Date(body.until) : null;
    const done = await this.refusing(() => this.service.freeze(actorOf(req), tenantId, userId, grantId, until));
    return { grantId, frozenUntil: done.frozenUntil?.toISOString() ?? null, configsDisabled: done.configsDisabled };
  }

  /** And unfreezes it: its end moves by the time it stood still. */
  @Post('grants/:grantId/unfreeze')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async unfreeze(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Req() req: Request,
  ) {
    const done = await this.refusing(() => this.service.unfreeze(actorOf(req), tenantId, userId, grantId));
    return { grantId, endsAt: done.endsAt?.toISOString() ?? null, configsRestored: done.configsRestored };
  }

  /**
   * An admin changes this Grant's days (F-311-i): `days` (±N from the end it
   * has) or `endsAt`, and the `reason` its history keeps. A closed Grant is a
   * renewal's, not a date's.
   */
  @Post('grants/:grantId/duration')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async duration(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantDurationSchema)) body: GrantDurationBody,
    @Req() req: Request,
  ) {
    const change = body.endsAt !== undefined ? { endsAt: new Date(body.endsAt) } : { days: body.days as number };
    const done = await this.refusing(() => this.service.changeDuration(actorOf(req), tenantId, userId, grantId, change, body.reason));
    return { grantId, changeId: done.changeId, endsAtBefore: done.endsAtBefore.toISOString(), endsAtAfter: done.endsAtAfter.toISOString() };
  }

  /**
   * An admin changes this Grant's traffic (F-311-j): `gb` (± GiB) and the
   * `reason` its adjustment row keeps. `spent` says the new Quota is at or
   * below what was used: the planner closes it and it is suspended from there.
   */
  @Post('grants/:grantId/traffic')
  @HttpCode(HttpStatus.OK)
  @actionLimit
  async traffic(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Body(new ZodValidationPipe(grantTrafficSchema)) body: GrantTrafficBody,
    @Req() req: Request,
  ) {
    const done = await this.refusing(() => this.service.changeTraffic(actorOf(req), tenantId, userId, grantId, bytesOfGb(body.gb), body.reason));
    return {
      grantId,
      adjustmentId: done.adjustmentId,
      purchasedBytesBefore: done.purchasedBytesBefore.toString(),
      purchasedBytesAfter: done.purchasedBytesAfter.toString(),
      usedBytes: done.usedBytes.toString(),
      spent: done.spent,
      revived: done.revived,
    };
  }

  /**
   * The door's refusals travel as `reason`, as on the other reseller surfaces;
   * a missing Grant is the owner routes' own 404. The link's two 409s
   * (`SubscriptionLinkService`) are already HTTP errors and pass through.
   */
  private async refusing<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ConfigActionRefused && e.reason === 'grant_not_found') {
        throw new NotFoundException({ i18nKey: E.grant.notFound, reason: e.reason, message: `${e.name}: ${e.message}` });
      }
      if (e instanceof EntitlementRefused) {
        const payload = { reason: e.reason, message: e.message };
        if (e.reason === 'grant_not_found') throw new NotFoundException({ i18nKey: E.grant.notFound, ...payload });
        if (GRANT_ACTION_STATUS[e.reason] === 400) throw new BadRequestException(payload);
        if (GRANT_ACTION_STATUS[e.reason] === 409) throw new ConflictException(payload);
        throw e;
      }
      if (!(e instanceof ResellerUserGrantsRefused)) throw e;
      const payload = { reason: e.reason, message: e.message };
      switch (STATUS[e.reason]) {
        case 403:
          throw new ForbiddenException(payload);
        case 404:
          throw new NotFoundException(payload);
        default:
          throw new ConflictException(payload);
      }
    }
  }
}

const actorOf = (req: Request) => {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions };
};
