import { SetMetadata } from '@nestjs/common';
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
 * Is this a reseller's platform subdomain? Then it serves nothing, to anyone
 * (ADR-0063, D-01). A reseller's only one is its CNAME target
 * `<slug>.edge.<domain>`, which connects its own domain and is never a door;
 * a `<slug>.<domain>` from before ADR-0063 is closed the same way, so a row
 * deleted in SQL and still in the cache is harmless.
 *
 * A fact about who owns the host — `surfaceTenantType`, of the surface's
 * tenant even when the request is scoped to its owner's (ADR-0059) — and not
 * about the reseller's gate, so no status is read. The platform owner's own
 * subdomains (`panel.<domain>`) are not closed; a reseller's proved custom
 * domain is its shop.
 */
export function doorClosed(tenant: ResolvedTenant): boolean {
  return tenant.surfaceDomainType === 'subdomain' && tenant.surfaceTenantType === 'reseller';
}

/**
 * Does this host serve the panel at all? The panel's half of the door rules
 * (F-066-x): `site-pwa` is a separate deployable and asks before it renders.
 *
 * No: a `subscription` or `assets` domain (F-066-q — it serves no panel page,
 * as it serves no panel route), and a reseller's platform subdomain.
 * Yes: everything else, including a request with no surface at all.
 */
export function doorServes(tenant: ResolvedTenant): boolean {
  if (tenant.surfacePurpose && tenant.surfacePurpose !== 'panel') return false;
  return !doorClosed(tenant);
}
