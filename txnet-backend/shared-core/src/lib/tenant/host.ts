/**
 * The host of a request, reduced to the form `tenant_domain.domainValue` is
 * stored in (ADR-0025).
 *
 * Pure, and separate from any lookup, so the rule can be asserted without a
 * database — the same split `vault.crypto.ts` makes.
 *
 * **It lives here rather than in one service** (F-092-j). It was
 * `auth-service/src/app/tenant/tenant.ts`'s while `auth-service` was the only
 * process that resolved a tenant from a Host; `billing-service`'s public
 * gateway callback is the second, and an Nx app cannot import an Nx app. Two
 * spellings of this would not fail a test — they would agree on every host
 * anyone tries by hand and disagree on `MyVPN.com:443`, which is the shape a
 * bank's redirect actually arrives in. `tenant.ts` re-exports it, so no caller
 * there was edited.
 */
export function normalizeHost(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let host = raw.trim().toLowerCase();
  if (!host) return null;

  if (host.startsWith('[')) {
    // An IPv6 literal is bracketed and its port sits outside the brackets:
    // `[::1]:3001`. Splitting on the first colon would truncate the address.
    const close = host.indexOf(']');
    if (close === -1) return null; // malformed — no host to speak of
    host = host.slice(0, close + 1);
  } else {
    const colon = host.indexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }

  // A fully-qualified name may carry the root dot: `myvpn.com.` is `myvpn.com`.
  host = host.replace(/\.+$/, '');
  return host || null;
}

/**
 * The label of the zone every reseller's CNAME target lives in (ADR-0060 (6)).
 * Reserved as a slug in `tenant-service`, so `edge.<domain>` is never a
 * reseller's own host.
 */
export const CNAME_TARGET_ZONE = 'edge';

/**
 * The host a reseller points its custom domain at: `<slug>.edge.<domain>`.
 *
 * One per reseller, not one shared by all: a CDN that forwards the CNAME
 * target instead of the visitor's host then still sends a host that names the
 * tenant. A shared target would name none.
 */
export function cnameTargetHost(slug: string, domain: string): string {
  return `${slug}.${CNAME_TARGET_ZONE}.${domain}`.toLowerCase();
}

/**
 * Is this platform-issued subdomain a CNAME target rather than a place a person
 * is sent? It only connects the reseller's own domain to the gateway and
 * **serves nothing itself** (ADR-0063): a request that arrives as it — opened
 * directly, or from a CDN that rewrites the host — is refused, so the
 * reseller's CDN must keep the visitor's host. Only a `subdomain` row is ours
 * to judge: a custom domain with `edge` as its second label is the tenant's
 * own name.
 */
export function isCnameTarget(domainValue: string, domainType: 'subdomain' | 'custom_domain'): boolean {
  return domainType === 'subdomain' && domainValue.split('.')[1] === CNAME_TARGET_ZONE;
}

/**
 * The one panel host a person is sent to for a tenant, of the rows it has:
 * a proven custom domain first, then a platform subdomain, each alphabetically
 * so two callers never disagree — and never a CNAME target. Billing's return
 * address (F-104), the handoff to a reseller's panel (F-061-f) and a branding
 * URL (F-018-h) all ask it. The caller filters to rows that are subdomains or
 * verified.
 *
 * `ownerType` is the tenant the rows belong to (F-018-aj). A **reseller's**
 * platform subdomain serves nothing (ADR-0063, auth-service `doorClosed`), so
 * for a reseller only its own custom domain is an answer, and `null` — which
 * every caller turns into a refusal or a fallback — beats sending a person to
 * a 404. The platform owner's own subdomains (`panel.<domain>`) are its doors.
 */
export function panelHostOf(
  rows: ReadonlyArray<{ domainValue: string; domainType: 'subdomain' | 'custom_domain' }>,
  ownerType: 'platform_owner' | 'reseller',
): string | null {
  const rank = (t: string) => (t === 'custom_domain' ? 0 : 1);
  const best = rows
    .filter((r) => !isCnameTarget(r.domainValue, r.domainType))
    .filter((r) => ownerType !== 'reseller' || r.domainType === 'custom_domain')
    .sort((a, b) => rank(a.domainType) - rank(b.domainType) || a.domainValue.localeCompare(b.domainValue))[0];
  return best?.domainValue ?? null;
}
