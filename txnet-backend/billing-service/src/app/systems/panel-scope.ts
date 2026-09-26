import { PanelOwnershipType, TenantType } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

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
 * Today only the platform owner passes, and its scope is the platform's panels
 * (`ownershipType = platform`, `tenantId` null — network invariant 9), not a
 * reseller's dedicated one. Opening the surface to a reseller is a change here
 * — `{ownershipType: tenant, tenantId}` — plus a decision
 * (`network/open-questions.md`), not a rewrite of any route.
 *
 * Read on the app pool: `tenant.tenant` has no RLS policy (as in
 * `GatewayAdminService.isOwner`).
 */
export async function panelScopeOf(prisma: PrismaService, actor: SystemsActor) {
  const tenant = await prisma.tenant.findUnique({ where: { id: actor.tenantId }, select: { tenantType: true } });
  if (tenant?.tenantType !== TenantType.platform_owner) throw new PanelScopeRefused('not_platform_owner');
  return { ownershipType: PanelOwnershipType.platform, tenantId: null };
}

export type PanelScope = Awaited<ReturnType<typeof panelScopeOf>>;

/**
 * Whether a panel met through another one — the panel a duplicate is, the one
 * holding an address — is the actor's to see. Only then is it named: a
 * reseller must never learn a platform panel's name through a refusal.
 */
export function inScope(scope: PanelScope, panel: { ownershipType: string; tenantId: string | null }): boolean {
  return panel.ownershipType === scope.ownershipType && panel.tenantId === scope.tenantId;
}
