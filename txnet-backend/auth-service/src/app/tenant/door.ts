import { SetMetadata } from '@nestjs/common';
import {
  TenantStatusStore,
  UnscopedRedisKeys,
  parseTenantStatusState,
} from '@txnet-backend/shared-core';
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
 * Is this a gated reseller's platform subdomain? Then it serves nothing, to
 * anyone — its end users and the reseller itself (F-066-x, user 2026-09-19;
 * D-01). The reseller configures from the platform's own panel until a domain
 * of its own is proved.
 *
 * **The gate that is read belongs to the tenant that owns the host** — `brand`
 * when the surface's tenant is not the scoped one, which is the reseller-owner
 * case of ADR-0059. Reading the scoped tenant instead would open the door for
 * precisely the account most likely to be standing at it.
 *
 * The Redis read is paid only on a `panel` `subdomain` surface: a custom
 * domain is the reseller's own shop and D-01 says nothing about it, and a
 * request with no surface has no door to judge.
 *
 * A missing or unparseable state closes nothing — the same trade
 * `TenantStatusGuard` makes and for the same reason: `TenantStatusListener`
 * recomputes every tenant on each connect, so the window is a boot.
 */
export async function gatedDoor(
  tenant: ResolvedTenant,
  store: TenantStatusStore,
): Promise<boolean> {
  if (tenant.surfacePurpose !== 'panel' || tenant.surfaceDomainType !== 'subdomain') {
    return false;
  }
  const surfaceTenantId = tenant.brand?.id ?? tenant.id;
  const state = parseTenantStatusState(
    await store.get(UnscopedRedisKeys.tenantStatus(surfaceTenantId)),
  );
  return state?.onboarding === true;
}

/**
 * Does this host serve the panel at all? The panel's half of the door rules
 * (F-066-x): `site-pwa` is a separate deployable and asks before it renders.
 *
 * No: a `subscription` or `assets` domain (F-066-q — it serves no panel page,
 * as it serves no panel route), and a gated reseller's platform subdomain.
 * Yes: everything else, including a request with no surface at all.
 */
export async function doorServes(
  tenant: ResolvedTenant,
  store: TenantStatusStore,
): Promise<boolean> {
  if (tenant.surfacePurpose && tenant.surfacePurpose !== 'panel') return false;
  return !(await gatedDoor(tenant, store));
}
