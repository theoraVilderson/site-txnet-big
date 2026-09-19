/**
 * What a host is, as far as the door rules care: the purpose of its
 * `tenant_domain` row, how the row was issued, and whose tenant it is. Every
 * field is absent when the request had no surface at all.
 */
export interface DoorSurface {
  purpose?: 'panel' | 'subscription' | 'assets' | null;
  domainType?: 'subdomain' | 'custom_domain' | null;
  tenantType?: 'platform_owner' | 'reseller' | null;
}

/**
 * Is this a reseller's platform subdomain? Then it serves nothing, to anyone
 * (ADR-0063, D-01). A reseller's only one is its CNAME target
 * `<slug>.edge.<domain>`, which connects its own domain and is never a door;
 * a `<slug>.<domain>` from before ADR-0063 is closed the same way, so a row
 * deleted in SQL and still in the cache is harmless.
 *
 * A fact about who owns the host — of the surface's tenant even when the
 * request is scoped to its owner's (ADR-0059) — and not about the reseller's
 * gate, so no status is read. The platform owner's own subdomains
 * (`panel.<domain>`) are not closed; a reseller's proved custom domain is its
 * shop.
 *
 * **Here and not in one service** (F-018-ak): `auth-service`'s `TenantGuard`
 * refuses on it, and so does every public route (`PublicRouteGuard`); two
 * copies would disagree on the first host nobody tried by hand.
 */
export function doorClosed(surface: DoorSurface): boolean {
  return surface.domainType === 'subdomain' && surface.tenantType === 'reseller';
}

/**
 * Does this host serve the panel at all? The panel's half of the door rules
 * (F-066-x): `site-pwa` is a separate deployable and asks before it renders,
 * at `GET /api/public/tenant/serves-panel`.
 *
 * No: a `subscription` or `assets` domain (F-066-q — it serves no panel page,
 * as it serves no panel route), and a reseller's platform subdomain.
 * Yes: everything else, including a request with no surface at all.
 */
export function doorServesPanel(surface: DoorSurface): boolean {
  if (surface.purpose && surface.purpose !== 'panel') return false;
  return !doorClosed(surface);
}
