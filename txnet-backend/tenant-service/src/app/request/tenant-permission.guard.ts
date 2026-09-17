import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from './identity.middleware';

/** The permission tenant administration needs (F-018-c). SuperAdmin holds it as `*`. */
export const TENANT_MANAGE = 'tenant.manage';

/**
 * The first door on tenant administration, as `notification-service`'s
 * `CampaignPermissionGuard` is on campaigns, and like it **not the boundary**:
 * that the caller is the platform owner is the service's own check, made on the
 * tenant row before any package or reseller row is read.
 *
 * It replaces `auth-service`'s `AuthGuard` + `PermissionsGuard` pair on the
 * moved routes (ADR-0058): here the claims are not this service's to verify —
 * `forward-auth` already did, and `IdentityMiddleware` carries its answer.
 */
@Injectable()
export class TenantPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, TENANT_MANAGE)) {
      throw new ForbiddenException(`${TENANT_MANAGE} is required`);
    }
    return true;
  }
}
