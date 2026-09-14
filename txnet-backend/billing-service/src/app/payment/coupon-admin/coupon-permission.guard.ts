import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';

/** The permission coupon management needs (F-502-a). SuperAdmin holds it as `*`. */
export const COUPON_MANAGE = 'coupon.manage';

/**
 * The first door on coupon management, like `GatewayPermissionGuard` and like
 * it **not the boundary**: what a caller may touch once through is
 * `CouponAdminService`'s — the platform owner every coupon, any other tenant
 * its own (ADR-0048 decision 8).
 */
@Injectable()
export class CouponPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, COUPON_MANAGE)) {
      throw new ForbiddenException(`${COUPON_MANAGE} is required`);
    }
    return true;
  }
}
