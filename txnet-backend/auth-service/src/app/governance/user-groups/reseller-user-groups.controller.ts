import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  ConflictException,
  Param,
  ParseUUIDPipe,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  RateLimitBucket,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  accessTraceOf,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';
import { Request } from 'express';

import { AuthGuard } from '../../auth/auth.guard';
import { RateLimit } from '../../auth/decorators/rate-limit.decorator';
import type { AuthClaims } from '../../auth/token.service';
import {
  UserGroupAdminService,
  UserGroupView,
} from './user-group-admin.service';

/** Invariant 21's refusals; a new reason does not compile until it gets a status. */
const STATUS: Record<ResellerAccessRejection, 403 | 404 | 409> = {
  not_allowed: 403,
  reseller_not_found: 404,
  reseller_suspended: 403,
  reseller_terminated: 409,
};

/**
 * `GET /api/auth/tenants/:tenantId/user-groups` — a reseller's groups, by the
 * path (F-102-g-d, ADR-0064 (1)). Its workspace's gateway editor picks a
 * gateway's audience from them (F-102-g); the ambient `/auth/user-groups` lists
 * the session tenant's, which for an owner on the platform panel is the
 * platform's.
 *
 * Read only, and nothing new is read: {@link ResellerAccess} (invariant 21)
 * admits the owner, a seat holding `tenant.manage`, or the platform owner's
 * staff, and the ambient service's own `list` runs in the reseller's scope —
 * so RLS, not a filter here, keeps it to that reseller's groups.
 */
@Controller('auth/tenants/:tenantId/user-groups')
@UseGuards(AuthGuard)
export class ResellerUserGroupsController {
  constructor(
    private readonly access: ResellerAccess,
    private readonly groups: UserGroupAdminService,
  ) {}

  @Get()
  @RateLimit({
    key: (req) =>
      rateLimitBucketKey(
        RateLimitBucket.USER_GROUP_READ,
        req?.user?.sub ?? req?.ip,
      ),
    configKey: 'USER_GROUP_READ_RATE_LIMIT',
    windowSec: 900,
  })
  async list(
    @Param('tenantId', new ParseUUIDPipe()) tenantId: string,
    @Req() req: Request,
  ): Promise<UserGroupView[]> {
    const user = (req as Request & { user: AuthClaims }).user;
    const actor = {
      userId: user.sub,
      tenantId: user.tenantId,
      permissions: user.permissions,
      trace: accessTraceOf(req),
    };
    try {
      return await this.access.run(actor, tenantId, 'read', () =>
        this.groups.list({
          adminId: user.sub,
          tenantId,
          ip: req.ip ?? '0.0.0.0',
        }),
      );
    } catch (err) {
      if (!(err instanceof ResellerAccessRefused)) throw err;
      const body = { reason: err.reason, message: err.message };
      if (STATUS[err.reason] === 404) throw new NotFoundException(body);
      if (STATUS[err.reason] === 409) throw new ConflictException(body);
      throw new ForbiddenException(body);
    }
  }
}
