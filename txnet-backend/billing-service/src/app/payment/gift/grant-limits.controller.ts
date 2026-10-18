import { Body, ConflictException, Controller, Get, Ip, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey, ResellerLimitReached, ZodValidationPipe } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { CompensationCapBody, compensationCapSchema } from './grant-compensation.schema';
import { FreezeSettingsBody, freezeSettingsSchema, TenantGrantLimitBody, tenantGrantLimitSchema } from './grant-limits.schema';
import { GrantLimitsService } from './grant-limits.service';
import { bytesOfGb } from './grant-traffic.schema';
import { actorOf, resellerRefusal } from './reseller-user-grants.controller';
import { ResellerUserGrantsRefused } from './reseller-user-grants.service';

/** Reading the numbers is part of reading a user's services (F-311-f): the same bucket. */
const readLimit = RateLimit({
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_GRANTS_READ, identityOf(req).userId),
  configKey: 'RESELLER_USER_GRANTS_READ_RATE_LIMIT',
  windowSec: 900,
});

/** A change is an admin's act on a user, as a freeze or a renewal is: their bucket. */
const writeLimit = RateLimit({
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_CONFIG_ACTION, identityOf(req).userId),
  configKey: 'RESELLER_USER_CONFIG_ACTION_RATE_LIMIT',
  windowSec: 900,
});

/**
 * The metered cap, for staff (F-118-ap, `entitlement/contract.limits.md`):
 * `/api/billing/tenants/:tenantId/grant-limits` — the tenant's default — and
 * `.../users/:userId/grant-limit` — one user's own number, set with a reason
 * and removed. Every answer is the whole view, so the panel never computes
 * which number is in effect.
 *
 * **No permission guard**, as on every reseller-named surface: the users-admin
 * door (`ResellerAccess.runIncludingPlatform`) is inside the service. The
 * tenant is the path's; the caller's session carries the platform's.
 */
@Controller('billing/tenants/:tenantId')
export class GrantLimitsController {
  constructor(private readonly limits: GrantLimitsService) {}

  @Get('grant-limits')
  @readLimit
  tenantLimit(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.refusing(() => this.limits.tenantLimit(actorOf(req), tenantId));
  }

  @Put('grant-limits')
  @writeLimit
  setTenantLimit(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(tenantGrantLimitSchema)) body: TenantGrantLimitBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.limits.setTenantLimit({ ...actorOf(req), ip }, tenantId, body.meteredOpenCap));
  }

  /** The compensation cap (KS-1-c): `days` and `bytes` per Grant over `windowDays`, the tenant's own or the platform's. */
  @Get('compensation-cap')
  @readLimit
  compensationCap(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.refusing(() => this.limits.compensationCap(actorOf(req), tenantId));
  }

  @Put('compensation-cap')
  @writeLimit
  setCompensationCap(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(compensationCapSchema)) body: CompensationCapBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const cap = body.cap && { days: body.cap.days, bytes: bytesOfGb(body.cap.gb) };
    return this.refusing(() => this.limits.setCompensationCap({ ...actorOf(req), ip }, tenantId, cap));
  }

  /** The tenant's freeze switches (F-0401-b): self-freeze on or off, and whether it stops the clock. */
  @Get('freeze-settings')
  @readLimit
  freezeSettings(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request) {
    return this.refusing(() => this.limits.freezeSettings(actorOf(req), tenantId));
  }

  @Put('freeze-settings')
  @writeLimit
  setFreezeSettings(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Body(new ZodValidationPipe(freezeSettingsSchema)) body: FreezeSettingsBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    const settings = { selfFreezeEnabled: body.selfFreezeEnabled, selfFreezeStopsClock: body.selfFreezeStopsClock };
    return this.refusing(() => this.limits.setFreezeSettings({ ...actorOf(req), ip }, tenantId, settings));
  }

  @Get('users/:userId/grant-limit')
  @readLimit
  userLimit(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('userId', new ParseUUIDPipe()) userId: string, @Req() req: Request) {
    return this.refusing(() => this.limits.userLimit(actorOf(req), tenantId, userId));
  }

  /** The door's refusals and an unknown user, as the user-grants surface answers them. */
  private async refusing<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ResellerUserGrantsRefused) throw resellerRefusal(e);
      // Above the reseller's ceiling (F-019-n): `used` is the number asked for.
      if (e instanceof ResellerLimitReached) {
        throw new ConflictException({ i18nKey: BackendI18nKeys.errors.billing.grantLimitAboveCeiling, reason: e.reason, message: e.message, facts: e.facts });
      }
      throw e;
    }
  }
}
