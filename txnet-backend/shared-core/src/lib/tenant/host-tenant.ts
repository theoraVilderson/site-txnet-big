import {
  DomainVerificationStatus,
  TenantDomainType,
  type PrismaClient,
  type TenantDomainPurpose,
} from '@prisma/client';
import { isCnameTarget } from './host';

/**
 * The tenant a **public** request's Host proves, for a route with no session to
 * carry one (ADR-0025).
 *
 * The same chain `auth-service`'s `TenantResolverService` walks, minus the
 * session and bot entries a public request cannot carry. Shared since F-018-m:
 * `billing-service`'s gateway callback was the first reader and the file route
 * the second, and two copies would agree on every host anyone tried by hand
 * and disagree on an unproven custom domain — which is exactly the host an
 * attacker would try.
 *
 * `purposes` is the caller's door (F-1212): a callback is a `panel` host's, a
 * file may also be fetched from the tenant's `assets` host.
 *
 * `db` must be the **cross-tenant** client. This read cannot be scoped: the
 * tenant it returns is what everything downstream is scoped by, and on the app
 * pool `tenant_domain`'s RLS policy shows a connection with no `app.tenant_id`
 * bound nothing at all.
 */
export async function tenantOfHost(
  db: Pick<PrismaClient, 'tenantDomain'>,
  host: string,
  purposes: readonly TenantDomainPurpose[],
): Promise<string | null> {
  const row = await db.tenantDomain.findUnique({
    where: { domainValue: host },
    select: { tenantId: true, domainType: true, purpose: true, verificationStatus: true },
  });
  if (!row || !purposes.includes(row.purpose)) return null;
  // A reseller's CNAME target only connects its domain; it is never a door
  // (ADR-0063), so it names no tenant here, like an unknown host.
  if (isCnameTarget(host, row.domainType)) return null;
  // A subdomain is issued by the platform, so matching the row is the whole
  // proof; a custom domain is the tenant's only once ownership has been shown.
  const proven =
    row.domainType === TenantDomainType.subdomain ||
    row.verificationStatus === DomainVerificationStatus.verified;
  return proven ? row.tenantId : null;
}
