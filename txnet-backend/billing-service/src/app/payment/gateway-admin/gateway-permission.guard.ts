import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';

/** The permission gateway management needs (F-102-c). SuperAdmin holds it as `*`. */
export const GATEWAY_MANAGE = 'gateway.manage';

/**
 * The first door on gateway management — like `SettlementPermissionGuard`, and
 * like it **not the boundary**. What a caller may do once through is
 * `GatewayAdminService`'s: the platform owner every gateway, any other tenant
 * its own. This narrows the surface to a role that was given it on purpose.
 */
@Injectable()
export class GatewayPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, GATEWAY_MANAGE)) {
      throw new ForbiddenException(`${GATEWAY_MANAGE} is required`);
    }
    return true;
  }
}
