import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/** The permission a tenant's support settings need (F-033-d, migration 20261003001300). */
export const SUPPORT_MANAGE_PERMISSION = 'support.manage';

/**
 * The first door on `/api/support/settings/*`, as `SupportAgentGuard` is on the
 * agent routes — not the boundary: every route writes only the gate's tenant.
 */
@Injectable()
export class SupportManageGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, SUPPORT_MANAGE_PERMISSION)) {
      throw new ForbiddenException(`${SUPPORT_MANAGE_PERMISSION} is required`);
    }
    return true;
  }
}
