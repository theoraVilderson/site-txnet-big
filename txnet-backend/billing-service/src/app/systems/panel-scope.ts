import { PanelOwnershipType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { isPlatformTenant, isResellerTenant } from '@txnet-backend/shared-core';

/** Who is acting on the systems surface: the gate's user and tenant, never a body field. */
export type SystemsActor = { adminId: string; tenantId: string };

export type PanelScopeRejection = 'not_platform_owner';

export class PanelScopeRefused extends Error {
  constructor(readonly reason: PanelScopeRejection) {
    super(reason);
    this.name = 'PanelScopeRefused';
  }
}

/**
 * The panels an actor may see and act on — the door and the scope in one place
 * (ADR-0080 decision 2). Every systems route starts here, so it doubles as the
 * `where` of each read and the ownership of each write.
 *
 * The platform's tenant gets the platform's panels (`ownershipType =
 * platform`, `tenantId` null — network invariant 9); a reseller its own
 * (`{tenant, tenantId}`, ADR-0166 point 2) — the actor's tenant is the path's
 * behind the reseller's door (`systems-door.ts`). No tenant is refused.
 *
 * `network.panel` is tenant-isolated: a reseller's panel is invisible to a
 * bare app-pool read, so every scoped read goes through the cross-tenant pool
 * with this scope in its `where` (BYO-1-b). `tenant.tenant` has no RLS policy,
 * so this read stays on the app pool (as in `GatewayAdminService.isOwner`).
 */
export async function panelScopeOf(prisma: PrismaService, actor: SystemsActor): Promise<PanelScope> {
  const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
  if (isPlatformTenant(tenant?.tenantType)) return { ownershipType: PanelOwnershipType.platform, tenantId: null };
  if (isResellerTenant(tenant?.tenantType)) return { ownershipType: PanelOwnershipType.tenant, tenantId: actor.tenantId };
  throw new PanelScopeRefused('not_platform_owner');
}

/** Whose panels a read or write is scoped to: the platform's (`tenantId` null), or one tenant's own (ADR-0162). */
export type PanelScope = { ownershipType: PanelOwnershipType; tenantId: string | null };

/**
 * Whether a panel met through another one — the panel a duplicate is, the one
 * holding an address — is the actor's to see. Only then is it named: a
 * reseller must never learn a platform panel's name through a refusal.
 */
export function inScope(scope: PanelScope, panel: { ownershipType: string; tenantId: string | null }): boolean {
  return panel.ownershipType === scope.ownershipType && panel.tenantId === scope.tenantId;
}
