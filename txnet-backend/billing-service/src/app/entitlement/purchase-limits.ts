import { GrantSource, Prisma } from '@prisma/client';
import { type ResellerLimitKey, resellerLimitsOf, TenantContext } from '@txnet-backend/shared-core';

import { PurchaseLimitReached, type PurchaseWindow } from './grant';

export { PurchaseLimitReached, type PurchaseWindow };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Each window, its key and its length: rolling, so no calendar edge lets a buyer double up. */
const WINDOWS: ReadonlyArray<{ key: ResellerLimitKey; window: PurchaseWindow; days: number }> = [
  { key: 'user_purchases_daily_max', window: 'day', days: 1 },
  { key: 'user_purchases_weekly_max', window: 'week', days: 7 },
  { key: 'user_purchases_monthly_max', window: 'month', days: 30 },
];

/**
 * One more buy for `userId` (F-019-t7): each window the reseller in scope has
 * a limit for — its own, its package's or the platform's (ADR-0106) — counts
 * the user's `purchase` Grants created inside it, under a per-user lock, and
 * refuses at the limit. A window with no limit, and the platform's own
 * tenant, count nothing. Gifts, coupons and an admin's issue are not buys.
 */
export async function assertPurchaseRoom(tx: Prisma.TransactionClient, userId: string, now = new Date()): Promise<void> {
  const tenantId = TenantContext.current('purchase limits').id;
  const inEffect = new Map((await resellerLimitsOf(tx, tenantId)).map((r) => [r.key, r.limit]));
  const bounded = WINDOWS.flatMap((w) => {
    const limit = inEffect.get(w.key);
    return limit === null || limit === undefined ? [] : [{ ...w, limit }];
  });
  if (bounded.length === 0) return;

  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`purchase_limit:${userId}`}))`;
  for (const w of bounded) {
    const bought = await tx.grant.count({ where: { userId, source: GrantSource.purchase, createdAt: { gt: new Date(now.getTime() - w.days * DAY_MS) } } });
    if (bought >= w.limit) throw new PurchaseLimitReached(w.window, w.limit, bought);
  }
}
