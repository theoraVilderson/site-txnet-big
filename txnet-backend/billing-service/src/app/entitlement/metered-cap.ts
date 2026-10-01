import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { resellerLimitOf, TenantContext } from '@txnet-backend/shared-core';

import { MeteredCapReached } from './grant';

export { MeteredCapReached };

/**
 * The metered cap (F-118-ao, `contract.limits.md`): a metered Grant costs
 * nothing at the sale, so a user holds at most this many open ones. A panel
 * seat is held from the sale, whether the service is used or not.
 *
 * The number is the user's own (`user_grant_limit`, staff's answer to a
 * ticket), else the tenant's default (`grant_limit_setting`), else this.
 */
export const PLATFORM_METERED_CAP = 5;

/** The highest number staff may set (F-118-ap): above it is a typo, not a ticket's answer. */
export const MAX_METERED_CAP = 1000;

/** What holds a seat: every state but the three that end a Grant. */
export const OPEN_GRANT_STATUSES: readonly GrantStatus[] = [GrantStatus.pending, GrantStatus.active, GrantStatus.suspended];

/**
 * The reseller's ceiling on the number it gives a user (F-019-n, ADR-0106
 * `user_metered_cap_max`), or `null` for none — the platform's own tenant
 * has none. Read in the current tenant's scope.
 */
export async function meteredCeilingOf(tx: Prisma.TransactionClient): Promise<number | null> {
  return (await resellerLimitOf(tx, TenantContext.current('metered ceiling').id, 'user_metered_cap_max')).limit;
}

/** `n`, bounded by the ceiling: a number set before the ceiling was lowered counts as the ceiling. */
export const underCeiling = (n: number, ceiling: number | null): number => (ceiling === null ? n : Math.min(n, ceiling));

/** The number in effect for this user of the current tenant — never above its reseller's ceiling. */
export async function meteredCapOf(tx: Prisma.TransactionClient, userId: string): Promise<number> {
  const tenantId = TenantContext.current('metered cap').id;
  const own = await tx.userGrantLimit.findUnique({ where: { tenantId_userId: { tenantId, userId } }, select: { meteredOpenCap: true } });
  const tenant = own ? null : await tx.grantLimitSetting.findUnique({ where: { tenantId }, select: { meteredOpenCap: true } });
  const n = own?.meteredOpenCap ?? tenant?.meteredOpenCap ?? PLATFORM_METERED_CAP;
  return underCeiling(n, await meteredCeilingOf(tx));
}

/**
 * Refuses one more metered Grant for this user when they hold the cap. The
 * count is taken under a per-user transaction lock, so two sales at once
 * cannot both see room for one; it is held until the caller's transaction ends.
 */
export async function assertMeteredRoom(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`metered_cap:${userId}`}))`;
  const open = await tx.grant.count({
    where: { userId, billingMode: VariantBillingMode.metered, status: { in: [...OPEN_GRANT_STATUSES] } },
  });
  const cap = await meteredCapOf(tx, userId);
  if (open >= cap) throw new MeteredCapReached(cap, open);
}
