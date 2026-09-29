import {
  BadRequestException,
  ConflictException,
  Controller,
  Delete,
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
  UseGuards,
} from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import { Request } from 'express';

import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import { AuthGuard } from '../auth.guard';
import { RateLimit } from '../decorators/rate-limit.decorator';
import type { AuthClaims } from '../token.service';
import { resellerUserListSchema, type ResellerUserListQuery } from './reseller-users.schema';
import {
  ResellerUsersActor,
  ResellerUsersRefused,
  ResellerUsersRejection,
  ResellerUsersService,
} from './reseller-users.service';

/** Every refusal of either door gets a status; a new reason does not compile until it gets one. */
const STATUS: Record<ResellerUsersRejection, 400 | 403 | 404 | 409> = {
  // ResellerAccess (tenant invariant 21): who may administer this reseller.
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
  // ResellerUsersService: what may be done to one of its users.
  user_not_found: 404,
  user_banned: 409,
  cannot_block_self: 400,
  no_authority: 403,
};

/**
 * A named reseller's own users (F-311-a, ADR-0064):
 * `/api/auth/tenants/:tenantId/users` — list, block, unblock. The data the
 * bot's reseller panel (F-311-c) is built on, and a future panel page with it.
 *
 * **No `PermissionsGuard`**, as on every other reseller-named surface: a
 * reseller's owner holds no operator permission — they are the platform's
 * customer — so `ResellerAccess` is the door, applied inside the service
 * together with the scope the work then runs in. `AuthGuard` stays, because
 * that door needs a caller to judge.
 *
 * **The tenant is the path's.** The owner signs in to the platform owner's
 * tenant (ADR-0059), so the session's `X-Tenant-Id` would read the wrong
 * tenant's users; nothing here accepts a `tenantId` anywhere but the path.
 *
 * **Unblock is `DELETE` of the block**, not a second verb on the user: the
 * thing this surface creates is a block, and removing it is how it ends.
 */
@Controller('auth/tenants/:tenantId/users')
@UseGuards(AuthGuard)
export class ResellerUsersController {
  constructor(private readonly users: ResellerUsersService) {}

  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_READ, req?.user?.sub ?? req?.ip),
    configKey: 'RESELLER_USER_READ_RATE_LIMIT',
    windowSec: 900,
  })
  list(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Query(new ZodValidationPipe(resellerUserListSchema)) query: ResellerUserListQuery,
    @Req() req: Request,
  ) {
    // The schema defaults both page keys; the cast is for this project's
    // non-strict tsconfig, under which zod infers every key as optional.
    return this.refusing(() =>
      this.users.list(this.actor(req), tenantId, query as Required<ResellerUserListQuery>),
    );
  }

  @Post(':userId/block')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_WRITE, req?.user?.sub ?? req?.ip),
    configKey: 'RESELLER_USER_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  block(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.users.block(this.actor(req), tenantId, userId, this.ip(req)));
  }

  @Delete(':userId/block')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.RESELLER_USER_WRITE, req?.user?.sub ?? req?.ip),
    configKey: 'RESELLER_USER_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  unblock(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Param('userId', new ParseUUIDPipe()) userId: string,
    @Req() req: Request,
  ) {
    return this.refusing(() => this.users.unblock(this.actor(req), tenantId, userId, this.ip(req)));
  }

  /** The caller, as `AuthGuard` left them on the request. */
  private actor(req: Request): ResellerUsersActor {
    const user = (req as Request & { user: AuthClaims }).user;
    return { userId: user.sub, tenantId: user.tenantId, permissions: user.permissions };
  }

  /** `admin_audit_log.adminIpAddress` is `NOT NULL`; an unresolvable peer is recorded as such. */
  private ip(req: Request): string {
    return req.ip ?? '0.0.0.0';
  }

  /** One refusal type in, one HTTP status out — the reason travels as the body's `reason`. */
  private async refusing<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof ResellerUsersRefused)) throw err;
      const body = { reason: err.reason };
      switch (STATUS[err.reason]) {
        case 400:
          throw new BadRequestException(body);
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
