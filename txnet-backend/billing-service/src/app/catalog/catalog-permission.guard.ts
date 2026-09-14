import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/** The permission catalog management needs (F-026-d). SuperAdmin holds it as `*`. */
export const CATALOG_MANAGE = 'catalog.manage';

/**
 * The first door on catalog management, like `CouponPermissionGuard` and like
 * it **not the boundary**: what a caller may touch once through is
 * `CatalogAdminService`'s — the platform owner every item, any other tenant
 * its own.
 */
@Injectable()
export class CatalogPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!holdsPermission(identityOf(req).permissions, CATALOG_MANAGE)) {
      throw new ForbiddenException(`${CATALOG_MANAGE} is required`);
    }
    return true;
  }
}
