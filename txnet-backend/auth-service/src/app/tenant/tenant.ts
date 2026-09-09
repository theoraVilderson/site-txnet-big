import { Request } from 'express';

/**
 * The tenant a request belongs to (ADR-0020).
 *
 * A **resolved** tenant, not the whole row: the id is what every scoped query
 * needs, and the slug is what a log line has to say for the fallback below to
 * be diagnosable at all. Anything more — branding, entitlements — is a separate
 * read by whoever actually needs it, and belongs to F-018.
 */
export interface ResolvedTenant {
  id: string;
  slug: string;
  /**
   * How the request arrived here: `domain` means a `tenant_domain` row matched
   * the host, `default` means nothing did and the deployment's configured
   * fallback answered. The distinction is ADR-0020's accepted footgun made
   * visible — a misconfigured host in production is served by the fallback and
   * looks identical in every other respect.
   */
  via: 'domain' | 'default';
}

/**
 * The host, reduced to the form `tenant_domain.domainValue` is stored in.
 *
 * Pure, and separate from the lookup, so the rule can be asserted without a
 * database — the same split `common/security/switch-scope.ts` makes.
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
 * The tenant this request resolved to, or `null` when it resolved to none.
 *
 * `null` is a real answer and never a reason to guess: a deployment whose
 * configured fallback tenant does not exist has a configuration bug, and
 * inventing `platform_owner` there would write accounts into a tenant nobody
 * asked for. Callers refuse instead.
 *
 * Set by `TenantMiddleware`, which runs on every route.
 */
export function resolveTenant(req: Request): ResolvedTenant | null {
  return (req as { tenant?: ResolvedTenant | null }).tenant ?? null;
}
