import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PlatformKey, isPlatformStaff } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';
import { identityOf } from './identity.middleware';

export const PLATFORM_KEY_METADATA = 'txnet:platform-key';

/** The platform key a route asks (AC-1-d, ADR-0135): on the class for a whole group, on a handler to differ. */
export const PlatformRoute = (key: PlatformKey) => SetMetadata(PLATFORM_KEY_METADATA, key);

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
    const key = this.reflector.getAllAndOverride<PlatformKey | undefined>(PLATFORM_KEY_METADATA, [context.getHandler(), context.getClass()]);
    // A guarded route that names no key is a wiring mistake: refuse rather than guess.
    if (!key) throw new ForbiddenException('a platform key is required');
    const identity = identityOf(context.switchToHttp().getRequest<Request>());
    if (!(await isPlatformStaff(this.prisma, identity, key))) {
      throw new ForbiddenException(`${key} is required`);
    }
    return true;
  }
}
