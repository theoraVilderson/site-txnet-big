/**
 * How many services one user of a reseller may buy (F-019-t7, user
 * 2026-10-01): in any 24 hours, 7 days and 30 days, each a limit of its own
 * set at ADR-0106's three levels, and each "no limit" unless set.
 *
 * What breaks without anyone seeing it:
 *  - **a window counted wrong.** Each counts the user's own `purchase` Grants
 *    created inside it; a gift, a coupon or an admin's issue is not a buy;
 *  - **a buyer told nothing useful.** The refusal names the window and the
 *    limit, since the buyer is the one it bounds;
 *  - **two buys at once both under the limit.** Counted under a per-user lock;
 *  - **reads for nothing.** With no limit set, nothing is counted or locked.
 */
import { GrantSource } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { assertPurchaseRoom, PurchaseLimitReached } from './purchase-limits';

const RESELLER = '22222222-2222-4222-8222-222222222222';
const USER = '77777777-7777-4777-8777-777777777777';
const NOW = new Date('2026-10-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function fakeTx(limits: Record<string, number | null>, boughtInDays: number[]) {
  const calls: string[] = [];
  const wheres: Array<Record<string, any>> = [];
  const tx = {
    $executeRaw: vi.fn(async () => (calls.push('lock'), 1)),
    tenant: { findUnique: async () => ({ tenantType: 'reseller' }) },
    tenantSubscription: { findUnique: async () => null },
    resellerLimit: { findMany: async () => [] },
    packageLimit: { findMany: async () => [] },
    resellerLimitSetting: { findMany: async () => Object.entries(limits).map(([key, value]) => ({ key, value })) },
    grant: {
      count: async ({ where }: { where: Record<string, any> }) => {
        calls.push('count');
        wheres.push(where);
        const since = (where.createdAt as { gt: Date }).gt.getTime();
        return boughtInDays.filter((d) => NOW.getTime() - d * DAY > since).length;
      },
    },
  };
  return { tx, calls, wheres };
}

const inReseller = <R>(fn: () => Promise<R>) => runWithTenant({ id: RESELLER }, fn);

describe('assertPurchaseRoom (F-019-t7)', () => {
  it('counts the user\'s own purchases in each window that has a limit, under the user\'s lock', async () => {
    const { tx, calls, wheres } = fakeTx({ user_purchases_daily_max: 3, user_purchases_monthly_max: 20 }, [0.1, 2, 10]);
    await expect(inReseller(() => assertPurchaseRoom(tx as never, USER, NOW))).resolves.toBeUndefined();
    expect(calls).toEqual(['lock', 'count', 'count']);
    expect(wheres[0]).toEqual({ userId: USER, source: GrantSource.purchase, createdAt: { gt: new Date(NOW.getTime() - DAY) } });
    expect(wheres[1].createdAt).toEqual({ gt: new Date(NOW.getTime() - 30 * DAY) });
  });

  it('refuses at a window\'s limit, naming the window, the limit and what was bought', async () => {
    const { tx } = fakeTx({ user_purchases_daily_max: 5, user_purchases_weekly_max: 3 }, [0.1, 1.5, 3, 6, 9]);
    const e = await inReseller(() => assertPurchaseRoom(tx as never, USER, NOW)).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PurchaseLimitReached);
    expect((e as PurchaseLimitReached).facts).toEqual({ window: 'week', limit: 3, bought: 4 });
  });

  it('reads and locks nothing when no window has a limit (the default)', async () => {
    const { tx, calls } = fakeTx({}, [0.1, 0.2, 0.3]);
    await expect(inReseller(() => assertPurchaseRoom(tx as never, USER, NOW))).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });
});
