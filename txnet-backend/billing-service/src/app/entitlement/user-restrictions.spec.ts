/**
 * Restrictions on one person, enforced where they bite (F-030-e; the keys
 * are governance's `USER_RESTRICTIONS`, set by staff under F-030-d).
 *
 * What breaks without anyone seeing it:
 *  - **a restriction that refuses nothing.** `services_active_max` and
 *    `configs_max` are asked at the buyer's own sale (a purchase or a coupon),
 *    `topup_categories_barred` at a top-up's gateway;
 *  - **staff refused.** An admin's issue, a renewal or a migration counts and
 *    is never refused (user 2026-10-13, as F-118-ao);
 *  - **an expired one still biting.** Only what holds now is read (`liveRestriction`);
 *  - **the metered number in two places.** A person's own number of open
 *    metered services is the `metered_services_max` restriction now, still
 *    under the reseller's ceiling (F-019-n) — `user_grant_limit` is gone;
 *  - **a refusal that does not say which.** The key and its figures ride as `facts`.
 */
import { ConfigStatus, GatewayCategory, GrantSource, GrantStatus, VariantBillingMode } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { MeteredCapReached } from './entitlement-refusals';
import { meteredCapOf } from './metered-cap';
import { assertBuyerRoom, assertTopUpAllowed, UserRestricted } from './user-restrictions';

const RESELLER = '22222222-2222-4222-8222-222222222222';
const USER = '77777777-7777-4777-8777-777777777777';

type Counts = { open?: number; metered?: number; configs?: number };

function fakeTx(restrictions: Record<string, unknown>, counts: Counts = {}, ceiling: number | null = null) {
  const calls: string[] = [];
  const restrictionWheres: Array<Record<string, unknown>> = [];
  const tx = {
    $executeRaw: vi.fn(async () => (calls.push('lock'), 1)),
    userRestriction: {
      findMany: async ({ where }: { where: { key?: { in: string[] } } & Record<string, unknown> }) => {
        restrictionWheres.push(where);
        const keys = where.key?.in;
        return Object.entries(restrictions)
          .filter(([key]) => !keys || keys.includes(key))
          .map(([key, value]) => ({ key, value }));
      },
    },
    grant: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        calls.push('grants');
        expect(where.status).toEqual({ in: [GrantStatus.pending, GrantStatus.active, GrantStatus.suspended] });
        return where.billingMode === VariantBillingMode.metered ? (counts.metered ?? 0) : (counts.open ?? 0);
      },
    },
    config: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        calls.push('configs');
        expect(where).toEqual({ userId: USER, status: { not: ConfigStatus.retired } });
        return counts.configs ?? 0;
      },
    },
    grantLimitSetting: { findUnique: async () => null },
    tenant: { findUnique: async () => ({ tenantType: 'reseller' }) },
    tenantSubscription: { findUnique: async () => null },
    resellerLimit: { findMany: async () => [] },
    packageLimit: { findMany: async () => [] },
    resellerLimitSetting: { findMany: async () => (ceiling === null ? [] : [{ key: 'user_metered_cap_max', value: ceiling }]) },
  };
  return { tx, calls, restrictionWheres };
}

const inReseller = <R>(fn: () => Promise<R>) => runWithTenant({ id: RESELLER }, fn);
const buy = { source: GrantSource.purchase, metered: false };
const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

describe('assertBuyerRoom (F-030-e)', () => {
  it('reads only what holds now, and with nothing set counts and locks nothing', async () => {
    const { tx, calls, restrictionWheres } = fakeTx({});
    await expect(inReseller(() => assertBuyerRoom(tx as never, USER, buy))).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(restrictionWheres[0]).toMatchObject({ userId: USER, OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }] });
  });

  it('refuses a sale at services_active_max, naming the key, the limit and what is open', async () => {
    const { tx, calls } = fakeTx({ services_active_max: 2 }, { open: 2 });
    const e = await refusalOf(inReseller(() => assertBuyerRoom(tx as never, USER, buy)));
    expect(e).toBeInstanceOf(UserRestricted);
    expect(e).toMatchObject({ reason: 'restriction_reached', facts: { key: 'services_active_max', limit: 2, used: 2 } });
    expect(calls).toEqual(['lock', 'grants']);
  });

  it('refuses a redeemed coupon too, and passes under the limit', async () => {
    const { tx } = fakeTx({ services_active_max: 0 });
    await expect(inReseller(() => assertBuyerRoom(tx as never, USER, { source: GrantSource.coupon, metered: false }))).rejects.toBeInstanceOf(UserRestricted);
    const { tx: room } = fakeTx({ services_active_max: 3 }, { open: 2 });
    await expect(inReseller(() => assertBuyerRoom(room as never, USER, buy))).resolves.toBeUndefined();
  });

  it('refuses a sale once the configs held reach configs_max — a service brings at least one', async () => {
    const { tx } = fakeTx({ configs_max: 4 }, { configs: 4 });
    const e = await refusalOf(inReseller(() => assertBuyerRoom(tx as never, USER, buy)));
    expect(e).toMatchObject({ reason: 'restriction_reached', facts: { key: 'configs_max', limit: 4, used: 4 } });
  });

  it('never refuses staff: an admin issue, a renewal or a migration reads nothing', async () => {
    const { tx, calls, restrictionWheres } = fakeTx({ services_active_max: 0, configs_max: 0, metered_services_max: 0 });
    for (const source of [GrantSource.admin_grant, GrantSource.migration]) {
      await expect(inReseller(() => assertBuyerRoom(tx as never, USER, { source, metered: true }))).resolves.toBeUndefined();
    }
    expect(calls).toEqual([]);
    expect(restrictionWheres).toEqual([]);
  });

  it('refuses a metered purchase at the person\'s own metered_services_max, as MeteredCapReached', async () => {
    const { tx } = fakeTx({ metered_services_max: 1 }, { metered: 1 });
    await expect(inReseller(() => assertBuyerRoom(tx as never, USER, { source: GrantSource.purchase, metered: true }))).rejects.toBeInstanceOf(MeteredCapReached);
  });
});

describe('meteredCapOf reads the person\'s number from the restriction (F-030-e)', () => {
  it('uses metered_services_max when set, else the defaults', async () => {
    await expect(inReseller(() => meteredCapOf(fakeTx({ metered_services_max: 12 }).tx as never, USER))).resolves.toBe(12);
    await expect(inReseller(() => meteredCapOf(fakeTx({}).tx as never, USER))).resolves.toBe(5);
  });

  it('never above the reseller\'s ceiling: a number set before it was lowered counts as the ceiling', async () => {
    await expect(inReseller(() => meteredCapOf(fakeTx({ metered_services_max: 50 }, {}, 20).tx as never, USER))).resolves.toBe(20);
  });
});

describe('assertTopUpAllowed (F-030-e)', () => {
  it('refuses a gateway whose category is barred, naming the key and the category', async () => {
    const { tx } = fakeTx({ topup_categories_barred: [GatewayCategory.crypto] });
    const e = await refusalOf(inReseller(() => assertTopUpAllowed(tx as never, USER, GatewayCategory.crypto)));
    expect(e).toMatchObject({ reason: 'restriction_reached', facts: { key: 'topup_categories_barred', category: GatewayCategory.crypto } });
    await expect(inReseller(() => assertTopUpAllowed(tx as never, USER, GatewayCategory.domestic_rial))).resolves.toBeUndefined();
  });
});
