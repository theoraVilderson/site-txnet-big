import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/** The permission the wheel's and the lottery's admin routes need (F-707-c). SuperAdmin holds it as `*`. */
export const ENGAGEMENT_MANAGE = 'engagement.manage';

/**
 * The first door on the wheel's settings, like `CouponPermissionGuard` and
 * like it **not the boundary**: the service runs in the caller's tenant
 * transaction, so RLS confines it to its own wheel.
 */
@Injectable()
export class EngagementPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, ENGAGEMENT_MANAGE)) {
      throw new ForbiddenException(`${ENGAGEMENT_MANAGE} is required`);
    }
    return true;
  }
}
