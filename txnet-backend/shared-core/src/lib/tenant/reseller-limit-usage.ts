import { GrantSource, GrantStatus, PanelOwnershipType, TenantDomainType, type Prisma } from '@prisma/client';

import { RESELLER_LIMIT_KEYS, type ResellerLimitKey } from './reseller-limits';

/** What holds a seat: every state but the three that end a Grant. */
export const OPEN_GRANT_STATUSES: readonly GrantStatus[] = [GrantStatus.pending, GrantStatus.active, GrantStatus.suspended];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The reads the counts need. Pass the reseller's own scope, or a cross-tenant pool. */
export type ResellerUsageReader = Pick<Prisma.TransactionClient, 'grant' | 'tenantDomain' | 'tenantStaffMember' | 'notificationCampaign'>;

type Count = (tx: ResellerUsageReader, tenantId: string, now: Date) => Promise<number>;

/**
 * How much of each limit a reseller holds (F-019-s): the one count each
 * refusal compares with the limit, so the workspace shows the same figure
 * that refuses. `null`: the key bounds a number set elsewhere, not a count —
 * `user_metered_cap_max` is checked against the value typed (F-019-n),
 * `bulk_job_grants_max` against one job's size (F-019-t5).
 * A new key is a line here too; the record does not compile without it.
 */
export const RESELLER_LIMIT_USAGE: Record<ResellerLimitKey, Count | null> = {
  user_metered_cap_max: null,
  /** Open Grants of variants whose group holds a platform panel (F-019-o). */
  platform_open_grants_max: (tx, tenantId) =>
    tx.grant.count({
      where: {
        tenantId,
        status: { in: [...OPEN_GRANT_STATUSES] },
        variant: { panelGroup: { members: { some: { panel: { ownershipType: PanelOwnershipType.platform } } } } },
      },
    }),
  /** Every `admin_grant` of the tenant in the last 30 days, whoever issued it (F-019-p). */
  admin_issues_30d_max: (tx, tenantId, now) =>
    tx.grant.count({ where: { tenantId, source: GrantSource.admin_grant, createdAt: { gt: new Date(now.getTime() - 30 * DAY_MS) } } }),
  /** Its custom domains, proved or not — each asks a certificate (F-019-q). */
  custom_domains_max: (tx, tenantId) => tx.tenantDomain.count({ where: { tenantId, domainType: TenantDomainType.custom_domain } }),
  /** Seats invited or accepted, neither removed nor expired — tenant's `staffState` other than `revoked`/`expired` (F-019-t1). */
  staff_members_max: (tx, tenantId, now) =>
    tx.tenantStaffMember.count({ where: { tenantId, revokedAt: null, OR: [{ accessExpiresAt: null }, { accessExpiresAt: { gt: now } }] } }),
  /** A ceiling on one job's size, checked against the job (F-019-t5). */
  bulk_job_grants_max: null,
  /** Its campaigns whose send started in the last 24 hours, stopped or done since (F-019-t4). */
  campaign_sends_daily_max: (tx, tenantId, now) => tx.notificationCampaign.count({ where: { tenantId, sendStartedAt: { gt: new Date(now.getTime() - DAY_MS) } } }),
};

/** One key's count, or `null` for a key that counts nothing. */
export function resellerUsageOf(tx: ResellerUsageReader, tenantId: string, key: ResellerLimitKey, now = new Date()): Promise<number | null> {
  const count = RESELLER_LIMIT_USAGE[key];
  return count ? count(tx, tenantId, now) : Promise.resolve(null);
}

/** Every key's count at once, for a page that shows them all. */
export async function resellerUsagesOf(tx: ResellerUsageReader, tenantId: string, now = new Date()): Promise<Record<ResellerLimitKey, number | null>> {
  const counts = await Promise.all(RESELLER_LIMIT_KEYS.map((key) => resellerUsageOf(tx, tenantId, key, now)));
  return Object.fromEntries(RESELLER_LIMIT_KEYS.map((key, i) => [key, counts[i]])) as Record<ResellerLimitKey, number | null>;
}
