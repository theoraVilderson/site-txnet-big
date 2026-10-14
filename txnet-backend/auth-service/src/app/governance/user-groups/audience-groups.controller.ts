import { Controller, ForbiddenException, Get, NotFoundException, ConflictException, Param, ParseUUIDPipe, Req, UseGuards } from '@nestjs/common';
import {
  AUDIENCE_DOOR_KEYS,
  AUDIENCE_FEATURE_KEYS,
  AudienceGroupOption,
  ResellerAccess,
  ResellerAccessRefused,
  accessTraceOf,
  holdsPermission,
  keysActingIn,
} from '@txnet-backend/shared-core';
import { Request } from 'express';

import { AuthGuard } from '../../auth/auth.guard';
import { RateLimit } from '../../auth/decorators/rate-limit.decorator';
import type { AuthClaims } from '../../auth/token.service';
import { AudienceGroupsService } from './audience-groups.service';
import { USER_GROUP_READ } from './user-group.controller';

/**
 * Which groups a caller may pick as an audience (GR-1-w, ADR-0143):
 * `GET /api/auth/audience-groups` in the session's tenant, and
 * `GET /api/auth/tenants/:tenantId/audience-groups` in a reseller by path, for
 * its owner and the platform's staff (ADR-0064 (1)). "Every user" is no group
 * and is not listed; the panel offers it beside these.
 *
 * Open to a manager of any audience feature: the list never depends on which,
 * and a caller holding none has nothing to aim.
 */
@Controller('auth')
@UseGuards(AuthGuard)
export class AudienceGroupsController {
  constructor(
    private readonly audiences: AudienceGroupsService,
    private readonly access: ResellerAccess,
  ) {}

  @Get('audience-groups')
  @RateLimit(USER_GROUP_READ)
  own(@Req() req: Request): Promise<AudienceGroupOption[]> {
    const user = claimsOf(req);
    if (!AUDIENCE_FEATURE_KEYS.some((key) => holdsPermission(user.permissions, key))) {
      throw new ForbiddenException({ reason: 'not_allowed', message: 'Managing a discount, gateway, product, lottery, wheel or campaign is required' });
    }
    return this.audiences.pickable(user.permissions);
  }

  @Get('tenants/:tenantId/audience-groups')
  @RateLimit(USER_GROUP_READ)
  async reseller(@Param('tenantId', new ParseUUIDPipe()) tenantId: string, @Req() req: Request): Promise<AudienceGroupOption[]> {
    const user = claimsOf(req);
    const caller = { userId: user.sub, tenantId: user.tenantId, permissions: user.permissions, trace: accessTraceOf(req) };
    try {
      return await this.access
        .for(...AUDIENCE_DOOR_KEYS)
        .run(caller, tenantId, 'read', (admitted) => this.audiences.pickable(keysActingIn(admitted.as, user.permissions)));
    } catch (err) {
      if (!(err instanceof ResellerAccessRefused)) throw err;
      const body = { reason: err.reason, message: err.message };
      if (err.reason === 'reseller_not_found') throw new NotFoundException(body);
      if (err.reason === 'reseller_terminated') throw new ConflictException(body);
      throw new ForbiddenException(body);
    }
  }
}

const claimsOf = (req: Request): AuthClaims => (req as Request & { user: AuthClaims }).user;
