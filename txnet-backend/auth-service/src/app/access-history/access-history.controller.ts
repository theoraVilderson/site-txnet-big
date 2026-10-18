import { Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Query, Req, UseGuards, ConflictException } from '@nestjs/common';
import { RateLimitBucket, accessTraceOf, rateLimitBucketKey, ZodValidationPipe } from '@txnet-backend/shared-core';
import { Request } from 'express';

import { AuthGuard } from '../auth/auth.guard';
import { RateLimit, type RateLimitOptions } from '../auth/decorators/rate-limit.decorator';
import type { AuthClaims } from '../auth/token.service';
import { historyQuerySchema, type HistoryQuery } from './access-history.schema';
import { AccessHistoryRefused, AccessHistoryRejection, AccessHistoryService } from './access-history.service';

/** Every refusal gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<AccessHistoryRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  consent_required: 403,
  consent_read_only: 403,
  user_not_found: 404,
};

/** A read about the reseller's people: the users-admin's per-caller read budget. */
const READ: RateLimitOptions = {
  key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_READ, req?.user?.sub ?? req?.ip),
  configKey: 'RESELLER_USER_READ_RATE_LIMIT',
  windowSec: 900,
};

/**
 * Who gave whom what (AC-1-p, audit `contract.md` "Access history"), on a
 * reseller's path. **No `PermissionsGuard`**: `ResellerAccess` is the door,
 * inside the service, as on every reseller-named surface.
 */
@Controller('auth/tenants/:tenantId')
@UseGuards(AuthGuard)
export class AccessHistoryController {
  constructor(private readonly history: AccessHistoryService) {}

  /** One person's access history, newest first. */
  @Get('users/:userId/access-history')
  @RateLimit(READ)
  ofPerson(
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request,
    @Query(new ZodValidationPipe(historyQuerySchema)) query: HistoryQuery,
  ) {
    return this.refusing(() => this.history.ofPerson(actorOf(req), tenantId, userId, query.page));
  }

  /** The tenant's access log: every act that moved someone's access, newest first (`audit.read`). */
  @Get('access-history')
  @RateLimit(READ)
  ofTenant(@Param('tenantId', ParseUUIDPipe) tenantId: string, @Req() req: Request, @Query(new ZodValidationPipe(historyQuerySchema)) query: HistoryQuery) {
    return this.refusing(() => this.history.ofTenant(actorOf(req), tenantId, query.page));
  }

  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof AccessHistoryRefused)) throw err;
      const body = { reason: err.reason };
      switch (STATUS[err.reason]) {
        case 403:
          throw new ForbiddenException(body);
        case 404:
          throw new NotFoundException(body);
        default:
          throw new ConflictException(body);
      }
    }
  }
}

/** The caller, as `AuthGuard` left them, with the request the door records for staff (F-117-c). */
function actorOf(req: Request) {
  const user = (req as Request & { user: AuthClaims }).user;
  return { userId: user.sub, tenantId: user.tenantId, permissions: user.permissions, trace: accessTraceOf(req) };
}
