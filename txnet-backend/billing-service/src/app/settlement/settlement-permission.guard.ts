import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/** The permission the platform owner's settlement role carries. */
export const SETTLEMENT_MANAGE = 'settlement.manage';

/**
 * The first of the two doors on the operator surface (F-096-e).
 *
 * `billing-service` had no guard until now: every route before this one is a
 * signed-in user acting on their own wallet, so the gate's identity *is* the
 * authorisation. This surface is the first where being signed in is not enough,
 * and it reads `X-User-Permissions` — the list `forward-auth` derived from the
 * caller's role and Traefik strips from the client
 * (`platform/forward-auth/contract.md`).
 *
 * **This guard is not the boundary, and must not be read as one.** A reseller
 * administers its own roles, so a tenant admin can hold `settlement.manage`
 * without the platform owner ever agreeing. What keeps this surface the
 * platform owner's is `SettlementService.assertOperator`, which every operation
 * opens with. This narrows the surface to a deliberate role and produces the
 * 403 that says so; the service's check is what makes the answer true.
 */
@Injectable()
export class SettlementPermissionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!identityOf(req).permissions.includes(SETTLEMENT_MANAGE)) {
      throw new ForbiddenException(`${SETTLEMENT_MANAGE} is required`);
    }
    return true;
  }
}
