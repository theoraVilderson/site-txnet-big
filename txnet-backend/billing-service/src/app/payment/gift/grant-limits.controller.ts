import { Body, Controller, Delete, Get, Ip, Param, ParseUUIDPipe, Put, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { TenantGrantLimitBody, tenantGrantLimitSchema, UserGrantLimitBody, userGrantLimitSchema } from './grant-limits.schema';
import { GrantLimitsService } from './grant-limits.service';
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

  @Get('users/:userId/grant-limit')
  @readLimit
  userLimit(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Param('userId', new ParseUUIDPipe()) userId: string, @Req() req: Request) {
    return this.refusing(() => this.limits.userLimit(actorOf(req), tenantId, userId));
  }

  @Put('users/:userId/grant-limit')
  @writeLimit
  setUserLimit(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Body(new ZodValidationPipe(userGrantLimitSchema)) body: UserGrantLimitBody,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.limits.setUserLimit({ ...actorOf(req), ip }, tenantId, userId, body.meteredOpenCap, body.reason));
  }

  @Delete('users/:userId/grant-limit')
  @writeLimit
  removeUserLimit(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
    @Ip() ip: string,
  ) {
    return this.refusing(() => this.limits.removeUserLimit({ ...actorOf(req), ip }, tenantId, userId));
  }

  /** The door's refusals and an unknown user, as the user-grants surface answers them. */
  private async refusing<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ResellerUserGrantsRefused) throw resellerRefusal(e);
      throw e;
    }
  }
}
