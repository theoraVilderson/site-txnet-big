import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { holdsPermission, ResellerAccess, ResellerAccessRefused, SupportConsentRefused } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { actorOf as resellerActorOf, resellerRefusal } from '../payment/gift/reseller-user-grants.controller';
import { ResellerUserGrantsRefused } from '../payment/gift/reseller-user-grants.service';
import { identityOf } from '../request/identity.middleware';
import type { SystemsActor } from './panel-scope';

/** The platform's own key for its panels (AC-1-d): the owner's door, and its staff's on a reseller's. */
export const NODE_MANAGE = 'platform.node.manage';

/** A reseller's key for its own panels (ADR-0166 point 3). */
const RESELLER_NODE_MANAGE = 'node.manage';

/** Where the reseller door is mounted beside the owner's: the same routes under the reseller's path (ADR-0166 point 1). */
export const RESELLER_SYSTEMS_PATH = 'billing/tenants/:tenantId/systems';

/** The tenant each admitted request acts for: set by the guard only, so an unguarded route names no actor. */
const admittedTenant = new WeakMap<Request, string>();

/**
 * The systems surface's two doors (BYO-1-b, ADR-0166). With no `:tenantId`
 * in the path it is the owner's: `platform.node.manage`, the session's tenant.
 * With one it is the reseller's: `ResellerAccess` on `node.manage` — the
 * owner, a member holding the key, or the platform's staff on
 * `platform.node.manage` — `read` to look and `staffWrite` to change, and the
 * actor is the **path's** tenant, never the session's: a reseller's owner
 * signs in on the platform's tenant (ADR-0059).
 */
@Injectable()
export class SystemsDoorGuard implements CanActivate {
  constructor(private readonly access: ResellerAccess) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const tenantId = req.params['tenantId'];
    if (tenantId === undefined) {
      if (!holdsPermission(identityOf(req).permissions, NODE_MANAGE)) throw new ForbiddenException(`${NODE_MANAGE} is required`);
      admittedTenant.set(req, identityOf(req).tenantId);
      return true;
    }
    const capability = req.method === 'GET' ? 'read' : 'staffWrite';
    try {
      await this.access.for(RESELLER_NODE_MANAGE).asStaff(NODE_MANAGE).admit(resellerActorOf(req), tenantId, capability);
    } catch (e) {
      // The door's reasons are every reseller route's (`resellerRefusal`).
      if (e instanceof ResellerAccessRefused || e instanceof SupportConsentRefused) throw resellerRefusal(new ResellerUserGrantsRefused(e.reason, tenantId));
      throw e;
    }
    admittedTenant.set(req, tenantId);
    return true;
  }
}

/** Who acts on the systems surface: the gate's user, for the tenant {@link SystemsDoorGuard} admitted. */
export function systemsActorOf(req: Request): SystemsActor {
  const tenantId = admittedTenant.get(req);
  if (tenantId === undefined) throw new Error('No systems door: SystemsDoorGuard did not run for this route');
  return { adminId: identityOf(req).userId, tenantId };
}
