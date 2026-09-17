import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/** The permission campaign management needs (F-035-c). SuperAdmin holds it as `*`. */
export const CAMPAIGN_MANAGE = 'campaign.manage';

/**
 * The first door on campaign management, like billing's `CouponPermissionGuard`
 * and like it **not the boundary**: which campaigns a caller may touch once
 * through is `CampaignAdminService`'s.
 */
@Injectable()
export class CampaignPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, CAMPAIGN_MANAGE)) {
      throw new ForbiddenException(`${CAMPAIGN_MANAGE} is required`);
    }
    return true;
  }
}
