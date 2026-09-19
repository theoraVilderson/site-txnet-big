import { SetMetadata } from '@nestjs/common';
import { doorClosed as sharedDoorClosed, doorServesPanel } from '@txnet-backend/shared-core';
import type { ResolvedTenant } from './tenant';

export const DOOR_PROBE = 'doorProbe';

/**
 * Marks the one route that asks *whether a door is open*, and so must answer
 * on a door that is not (F-066-x). `TenantGuard` skips its surface refusals —
 * the purpose check and the closed platform subdomain — for it, and only them:
 * a host that resolves to no tenant is still the neutral 404, and a claim that
 * disagrees with its surface is still the 403.
 *
 * Greppable like `TenantAgnostic`: `grep -rn DoorProbe` is the audit, and the
 * list is meant to stay one route long.
 */
export const DoorProbe = () => SetMetadata(DOOR_PROBE, true);

/**
 * The door rules live in `shared-core` (F-018-ak): `TenantGuard` here and
 * every public route in another service refuse on the same one. These two
 * read them off a resolved tenant's surface.
 */
export function doorClosed(tenant: ResolvedTenant): boolean {
  return sharedDoorClosed(surfaceOf(tenant));
}

/** @deprecated since 2026-09-19 with `GET /api/auth/door` — the panel asks `GET /api/public/tenant/serves-panel`. */
export function doorServes(tenant: ResolvedTenant): boolean {
  return doorServesPanel(surfaceOf(tenant));
}

function surfaceOf(tenant: ResolvedTenant) {
  return {
    purpose: tenant.surfacePurpose,
    domainType: tenant.surfaceDomainType,
    tenantType: tenant.surfaceTenantType,
  };
}
