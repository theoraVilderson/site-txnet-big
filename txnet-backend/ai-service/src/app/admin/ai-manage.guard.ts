import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/** The permission a tenant's AI admin needs (F-038-j1). Admin holds it; SuperAdmin as `*`. */
export const AI_MANAGE_PERMISSION = 'ai.manage';

/**
 * The first door on `/api/ai/admin/*`, like billing's `CouponPermissionGuard`
 * and like it **not the boundary**: every route reads and writes only the
 * gate's tenant (`X-Tenant-Id`), and no body names one.
 */
@Injectable()
export class AiManageGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, AI_MANAGE_PERMISSION)) {
      throw new ForbiddenException(`${AI_MANAGE_PERMISSION} is required`);
    }
    return true;
  }
}
