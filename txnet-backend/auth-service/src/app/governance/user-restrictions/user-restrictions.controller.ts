import { Body, Controller, Delete, Get, HttpException, Param, ParseUUIDPipe, Put, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, accessTraceOf, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { Request } from 'express';

import { AuthGuard } from '../../auth/auth.guard';
import { RateLimit, type RateLimitOptions } from '../../auth/decorators/rate-limit.decorator';
import type { AuthClaims } from '../../auth/token.service';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { restrictionKeyParamSchema, setRestrictionSchema, type SetRestrictionInput } from './user-restriction.schema';
import { UserRestrictionsRefused, UserRestrictionsService, type UserRestrictionsRejection } from './user-restrictions.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<UserRestrictionsRejection, 400 | 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  consent_required: 403,
  consent_read_only: 403,
  user_not_found: 404,
  no_authority: 403,
  restriction_unknown: 400,
  restriction_value_invalid: 400,
  restriction_not_found: 404,
  expiry_past: 400,
};

/** A read of one person, on the users-admin's per-caller read budget. */
const PERSON_READ: RateLimitOptions = {
  key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_READ, req?.user?.sub ?? req?.ip),
  configKey: 'RESELLER_USER_READ_RATE_LIMIT',
  windowSec: 900,
};

/** An act on a person, on the users-admin's per-caller write budget, as a key given is. */
const PERSON_WRITE: RateLimitOptions = {
  key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_WRITE, req?.user?.sub ?? req?.ip),
  configKey: 'RESELLER_USER_WRITE_RATE_LIMIT',
  windowSec: 900,
};

/**
 * A person's restrictions on the tenant's own path (F-030-d):
 * `/auth/tenants/:tenantId/users/:userId/restrictions`. **No
 * `PermissionsGuard`**, as on every reseller-named surface: `ResellerAccess`
 * on `restriction.assign` is the door, inside the service.
 */
@Controller('auth/tenants/:tenantId/users/:userId/restrictions')
@UseGuards(AuthGuard)
export class UserRestrictionsController {
  constructor(private readonly restrictions: UserRestrictionsService) {}

  /** The restrictions that hold now, and the keys a form may offer. */
  @Get()
  @RateLimit(PERSON_READ)
  list(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Param('userId', ParseUUIDPipe) userId: string, @Req() req: Request) {
    return this.refusing(() => this.restrictions.list(actorOf(req), tenantId, userId));
  }

  /** Set or change one restriction, with a reason and an optional end. */
  @Put(':key')
  @RateLimit(PERSON_WRITE)
  set(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('key', new ZodValidationPipe(restrictionKeyParamSchema)) key: string,
    @Req() req: Request,
    @Body(new ZodValidationPipe(setRestrictionSchema)) body: SetRestrictionInput,
  ) {
    return this.refusing(() => this.restrictions.set(actorOf(req), tenantId, userId, key, body, req.ip ?? '0.0.0.0'));
  }

  /** Lift one restriction by hand. */
  @Delete(':key')
  @RateLimit(PERSON_WRITE)
  lift(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('key', new ZodValidationPipe(restrictionKeyParamSchema)) key: string,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.restrictions.lift(actorOf(req), tenantId, userId, key, req.ip ?? '0.0.0.0'));
  }

  /** One refusal type in, one HTTP status out — the reason travels as the body's `reason`. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof UserRestrictionsRefused) throw new HttpException({ reason: err.reason }, STATUS[err.reason]);
      throw err;
    }
  }
}

/** The caller, as `AuthGuard` left them, with the request the door records for staff (F-117-c). */
function actorOf(req: Request) {
  const user = (req as Request & { user: AuthClaims }).user;
  return { userId: user.sub, tenantId: user.tenantId, permissions: user.permissions, trace: accessTraceOf(req) };
}
