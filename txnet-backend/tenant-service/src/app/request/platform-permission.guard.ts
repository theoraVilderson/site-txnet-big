import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformKey, holdsPermission, isPlatformStaff } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { identityOf } from './identity.middleware';

export const PLATFORM_KEY_METADATA = 'txnet:platform-key';

/**
 * The platform keys a route asks, any one of which admits (AC-1-d, ADR-0135):
 * on the class for a whole group, on a handler to differ. More than one only
 * where another kind of staff work needs the same read — the reseller list for
 * `platform.support` (ADR-0141 (4)).
 */
export const PlatformRoute = (...keys: [PlatformKey, ...PlatformKey[]]) => SetMetadata(PLATFORM_KEY_METADATA, keys);

/**
 * The first door on the platform's tenant administration (F-018-c, AC-1-d):
 * the route's own platform key (`@PlatformRoute`), held by a caller signed in to
 * the platform owner's tenant — `isPlatformStaff`, so a reseller's user is
 * refused whatever their token claims, `*` included (catalog §3.3).
 *
 * Like `notification-service`'s `CampaignPermissionGuard` it is **not the
 * boundary**: that the caller is the platform owner is still each service's own
 * check, made on the tenant row before any package or reseller row is read. It
 * replaces `TenantPermissionGuard` and its one key `tenant.manage`.
 */
@Injectable()
export class PlatformPermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const keys = this.reflector.getAllAndOverride<readonly PlatformKey[] | undefined>(PLATFORM_KEY_METADATA, [context.getHandler(), context.getClass()]);
    // A guarded route that names no key is a wiring mistake: refuse rather than guess.
    if (!keys?.length) throw new ForbiddenException('a platform key is required');
    const identity = identityOf(context.switchToHttp().getRequest<Request>());
    const held = keys.find((key) => holdsPermission(identity.permissions, key));
    if (!held || !(await isPlatformStaff(this.prisma, identity, held))) {
      throw new ForbiddenException(`${keys.join(' or ')} is required`);
    }
    return true;
  }
}
