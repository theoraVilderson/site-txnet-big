import { DomainVerificationStatus, Prisma, TenantDomainPurpose, TenantDomainType } from '@prisma/client';
import { panelHostOf } from '@txnet-backend/shared-core';

/** The panel's My services page — `PANEL_MY_SERVICES` in `site-pwa/src/lib/routes.ts` (C-10). */
export const PANEL_MY_SERVICES_PATH = '/services';

/**
 * `path` on the tenant's own panel, absolute, or `null` when it has no host a
 * user can be sent to.
 *
 * The host is a `panel` door the tenant has proven: a platform subdomain is
 * issued by us, so matching the row is the whole proof; a custom one is only
 * the tenant's once ownership has been shown, which is the same rule
 * `auth-service`'s resolver applies to an incoming Host. A reseller's platform
 * subdomain serves nothing (ADR-0063), so a reseller with no domain of its own
 * has none. Deterministic, so two callers never disagree about the host:
 * proven custom domains first, then alphabetically (`panelHostOf`).
 *
 * One rule for every link billing hands out — a payment's return (F-018-aj)
 * and a delivered Grant's "open it" (F-601-h).
 */
export async function panelUrlOf(tx: Prisma.TransactionClient, tenantId: string, path: string): Promise<string | null> {
  const rows = await tx.tenantDomain.findMany({
    where: {
      tenantId,
      purpose: TenantDomainPurpose.panel,
      OR: [{ domainType: TenantDomainType.subdomain }, { verificationStatus: DomainVerificationStatus.verified }],
    },
    select: { domainValue: true, domainType: true },
    orderBy: [{ domainType: 'desc' }, { domainValue: 'asc' }],
  });
  const owner = await tx.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
  if (!owner) return null;
  const host = panelHostOf(rows, owner.tenantType);
  return host ? `https://${host}${path}` : null;
}
