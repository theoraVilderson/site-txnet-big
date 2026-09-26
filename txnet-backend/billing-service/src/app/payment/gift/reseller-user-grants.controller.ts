import {
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { ConfigActionRefused } from '../../traffic/config-actions';
import { GrantListQuery, grantListSchema } from './grant-list.schema';
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

/** One bucket for all four: expanding one Grant asks three of them at once. */
const readLimit = RateLimit({
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_GRANTS_READ, identityOf(req).userId),
  configKey: 'RESELLER_USER_GRANTS_READ_RATE_LIMIT',
  windowSec: 900,
});

/**
 * An admin reads one user's services (F-311-f): the owner's four reads —
 * Grant list, a Grant's configs, its 30-day usage, its `/sub` link — for a
 * user of the reseller the **path** names. The data half of the panel's and
 * the bot's user sheet (F-311-v, F-311-y).
 *
 * **No permission guard**, as on every reseller-named surface: `ResellerAccess`
 * is the door, inside the service. **The tenant is the path's**: the owner's
 * session carries the platform's `X-Tenant-Id` (ADR-0059).
 */
@Controller('billing/tenants/:tenantId/users/:userId/grants')
export class ResellerUserGrantsController {
  constructor(private readonly service: ResellerUserGrantsService) {}

  @Get()
  @readLimit
  grants(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Query(new ZodValidationPipe(grantListSchema)) query: GrantListQuery,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.service.grants(actorOf(req), tenantId, userId, query));
  }

  @Get(':grantId/configs')
  @readLimit
  async configs(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Param('grantId', new ParseUUIDPipe()) grantId: string,
    @Req() req: Request,
  ) {
    return { grantId, rows: await this.refusing(() => this.service.configs(actorOf(req), tenantId, userId, grantId)) };
  }

  @Get(':grantId/usage')
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
  @Get(':grantId/subscription-link')
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
