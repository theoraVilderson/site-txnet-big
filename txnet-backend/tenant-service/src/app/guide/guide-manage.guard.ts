import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/** The permission the guide settings need (F-414-c, migration 20261004000600). */
export const GUIDE_MANAGE_PERMISSION = 'guide.manage';

/**
 * The first door on `/api/guides/settings/*` — not the boundary: `GuideAdmin`
 * writes only the caller tenant's guides, or the platform's for the platform
 * owner's admin.
 */
@Injectable()
export class GuideManageGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, GUIDE_MANAGE_PERMISSION)) {
      throw new ForbiddenException(`${GUIDE_MANAGE_PERMISSION} is required`);
    }
    return true;
  }
}
