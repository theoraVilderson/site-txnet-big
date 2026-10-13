import { ConfigStatus, GatewayCategory, GrantSource, Prisma } from '@prisma/client';
import { BackendI18nKeys, OPEN_GRANT_STATUSES, liveRestrictionsOf, type UserRestrictionKey } from '@txnet-backend/shared-core';

import { UserRestricted } from './entitlement-refusals';
import { assertMeteredRoom } from './metered-cap';

export { UserRestricted };

/** The person's sentence for each restriction — exhaustive, so a new key does not compile without one (C-07). */
export const RESTRICTED_I18N_KEY: Record<UserRestrictionKey, string> = BackendI18nKeys.errors.billing.restricted;

/**
 * The person's own acts a restriction bounds (user 2026-10-13): a buy and a
 * redeemed coupon. An admin's issue, a renewal or a migration counts toward
 * what they hold and is never refused — staff knowingly make the exception.
 */
const BUYER_SOURCES: ReadonlySet<GrantSource> = new Set([GrantSource.purchase, GrantSource.coupon]);

/** The count restrictions a sale is weighed against, each with how much the person already holds. */
const HELD: ReadonlyArray<{ key: UserRestrictionKey; count: (tx: Prisma.TransactionClient, userId: string) => Promise<number> }> = [
  { key: 'services_active_max', count: (tx, userId) => tx.grant.count({ where: { userId, status: { in: [...OPEN_GRANT_STATUSES] } } }) },
  // A sale brings at least one config; how many is its fulfilment's, which is never refused once paid.
  { key: 'configs_max', count: (tx, userId) => tx.config.count({ where: { userId, status: { not: ConfigStatus.retired } } }) },
];

/**
 * One more service for `userId` (F-030-e), asked at invoice create and again
 * at issue: the metered cap on a metered purchase (F-118-ao, its own refusal
 * as before), then each count restriction set on the person. Counted under a
 * per-user lock held to the caller's transaction's end, so two sales at once
 * cannot both see room for one. Nothing set: nothing counted or locked.
 */
export async function assertBuyerRoom(tx: Prisma.TransactionClient, userId: string, sale: { source: GrantSource; metered: boolean }): Promise<void> {
  if (!BUYER_SOURCES.has(sale.source)) return;
  if (sale.source === GrantSource.purchase && sale.metered) await assertMeteredRoom(tx, userId);

  const live = await liveRestrictionsOf(tx, userId, HELD.map((h) => h.key));
  if (live.size === 0) return;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`user_restriction:${userId}`}))`;
  for (const { key, count } of HELD) {
    const limit = live.get(key);
    if (typeof limit !== 'number') continue;
    const used = await count(tx, userId);
    if (used >= limit) throw new UserRestricted(key, { limit, used });
  }
}

/**
 * A top-up through a gateway of `category` (F-030-e): refused when staff
 * barred that method for this person. The payer's own top-up only — a
 * reseller's billing top-up names no person and is never asked.
 */
export async function assertTopUpAllowed(tx: Prisma.TransactionClient, userId: string, category: GatewayCategory): Promise<void> {
  const barred = (await liveRestrictionsOf(tx, userId, ['topup_categories_barred'])).get('topup_categories_barred');
  if (Array.isArray(barred) && barred.includes(category)) throw new UserRestricted('topup_categories_barred', { category });
}

/** The categories barred for `userId`, for a list that should not offer them. */
export async function barredTopUpCategories(tx: Prisma.TransactionClient, userId: string): Promise<ReadonlySet<string>> {
  const barred = (await liveRestrictionsOf(tx, userId, ['topup_categories_barred'])).get('topup_categories_barred');
  return new Set(Array.isArray(barred) ? barred : []);
}
