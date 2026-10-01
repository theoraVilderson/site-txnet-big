/**
 * Reseller limits at three levels (ADR-0106, F-019-m): the reseller's own, its
 * package's, the platform's — else the code default. What breaks quietly:
 *
 *  - **the wrong level wins.** The most specific row wins, and a row whose
 *    value is `null` is "no limit", not "not set here": it stops the search;
 *  - **the platform bounded by itself.** Only a reseller has limits; the
 *    platform's own tenant (and any other kind) answers no limit;
 *  - **a reseller with no package.** It skips that level, never errors;
 *  - **a refusal with no figures.** It carries the key, the limit and the use;
 *  - **a guard sold past** (F-019-v1, ADR-0107). Only a `quota` key resolves
 *    an overage; its mode has the same three levels, apart from the number,
 *    and is `stop` with no row.
 */
import { Prisma } from '@prisma/client';

import {
  assertUnderLimit,
  RESELLER_LIMIT_KEYS,
  RESELLER_LIMITS,
  ResellerLimitReached,
  RESELLER_QUOTA_KEYS,
  resellerLimitOf,
  resellerLimitsOf,
  resellerOverageOf,
  resellerOveragesOf,
} from './reseller-limits';

const RESELLER = '22222222-2222-4222-8222-222222222222';
const PLATFORM = '11111111-1111-4111-8111-111111111111';
const PACKAGE = '33333333-3333-4333-8333-333333333333';

type Rows = {
  tenantType?: string;
  packageId?: string | null;
  own?: Record<string, number | null>;
  pkg?: Record<string, number | null>;
  platform?: Record<string, number | null>;
};

function fakeTx(rows: Rows) {
  const toRows = (m: Record<string, number | null> = {}) => Object.entries(m).map(([key, value]) => ({ key, value }));
  return {
    tenant: { findUnique: async () => ({ tenantType: rows.tenantType ?? 'reseller' }) },
    tenantSubscription: { findUnique: async () => (rows.packageId === null ? null : { packageId: rows.packageId ?? PACKAGE }) },
    resellerLimit: { findMany: async ({ where }: { where: { key?: { in: string[] } } }) => toRows(rows.own).filter((r) => !where.key || where.key.in.includes(r.key)) },
    packageLimit: { findMany: async ({ where }: { where: { key?: { in: string[] } } }) => toRows(rows.pkg).filter((r) => !where.key || where.key.in.includes(r.key)) },
    resellerLimitSetting: { findMany: async ({ where }: { where: { key?: { in: string[] } } }) => toRows(rows.platform).filter((r) => !where.key || where.key.in.includes(r.key)) },
  };
}

describe('RESELLER_LIMITS', () => {
  it('holds its keys, each with a default within its bound', () => {
    expect([...RESELLER_LIMIT_KEYS].sort()).toEqual(['admin_issues_30d_max', 'bulk_job_grants_max', 'campaign_sends_daily_max', 'custom_domains_max', 'end_users_max', 'platform_open_grants_max', 'platform_traffic_gib_monthly_max', 'staff_members_max', 'user_metered_cap_max', 'user_purchases_daily_max', 'user_purchases_monthly_max', 'user_purchases_weekly_max']);
    for (const key of RESELLER_LIMIT_KEYS) {
      const def = RESELLER_LIMITS[key];
      expect(def.default === null || (def.default >= 0 && def.default <= def.max)).toBe(true);
    }
  });
});

describe('RESELLER_LIMITS kinds (ADR-0107 point 1)', () => {
  it('every key has a kind; only campaign sends is a quota today, every ceiling a guard', () => {
    for (const key of RESELLER_LIMIT_KEYS) expect(['quota', 'guard']).toContain(RESELLER_LIMITS[key].kind);
    expect(RESELLER_QUOTA_KEYS).toEqual(['campaign_sends_daily_max']);
  });
});

type Over = { mode: 'stop' | 'overage'; unitPrice?: string; currencyCode?: string };

function overageTx(rows: { tenantType?: string; packageId?: string | null; own?: Record<string, Over>; pkg?: Record<string, Over>; platform?: Record<string, Over> }) {
  const toRows = (m: Record<string, Over> = {}) => (args: { where: { key: { in: string[] } } }) =>
    Object.entries(m)
      .filter(([key]) => args.where.key.in.includes(key))
      .map(([key, o]) => ({ key, mode: o.mode, unitPrice: o.unitPrice ? new Prisma.Decimal(o.unitPrice) : null, currencyCode: o.currencyCode ?? null }));
  return {
    tenant: { findUnique: async () => ({ tenantType: rows.tenantType ?? 'reseller' }) },
    tenantSubscription: { findUnique: async () => (rows.packageId === null ? null : { packageId: rows.packageId ?? PACKAGE }) },
    resellerQuotaOverage: { findMany: async (a: never) => toRows(rows.own)(a) },
    packageQuotaOverage: { findMany: async (a: never) => toRows(rows.pkg)(a) },
    quotaOverageSetting: { findMany: async (a: never) => toRows(rows.platform)(a) },
  };
}

describe('resellerOverageOf', () => {
  const KEY = 'campaign_sends_daily_max';
  const priced = (p: string): Over => ({ mode: 'overage', unitPrice: p, currencyCode: 'USD' });

  it('is stop with no row at any level', async () => {
    await expect(resellerOverageOf(overageTx({}) as never, RESELLER, KEY)).resolves.toEqual({ mode: 'stop', unitPrice: null, currencyCode: null, source: 'default' });
  });

  it('the reseller over its package over the platform, the price with its currency', async () => {
    const tx = overageTx({ platform: { [KEY]: priced('1.00') }, pkg: { [KEY]: { mode: 'stop' } }, own: { [KEY]: priced('0.40') } });
    const got = await resellerOverageOf(tx as never, RESELLER, KEY);
    expect(got).toMatchObject({ mode: 'overage', currencyCode: 'USD', source: 'reseller' });
    expect(got.unitPrice?.toFixed(2)).toBe('0.40');
    await expect(resellerOverageOf(overageTx({ platform: { [KEY]: priced('1.00') }, pkg: { [KEY]: { mode: 'stop' } } }) as never, RESELLER, KEY)).resolves.toMatchObject({
      mode: 'stop',
      source: 'package',
    });
  });

  it('skips the package level with no subscription', async () => {
    await expect(resellerOverageOf(overageTx({ packageId: null, pkg: { [KEY]: priced('5') } }) as never, RESELLER, KEY)).resolves.toMatchObject({ mode: 'stop', source: 'default' });
  });

  it('a guard is always stop, whatever a row says; the platform\'s own tenant is exempt', async () => {
    await expect(resellerOverageOf(overageTx({ own: { custom_domains_max: priced('1') } }) as never, RESELLER, 'custom_domains_max')).resolves.toEqual({
      mode: 'stop',
      unitPrice: null,
      currencyCode: null,
      source: 'default',
    });
    await expect(resellerOverageOf(overageTx({ tenantType: 'platform_owner', own: { [KEY]: priced('1') } }) as never, PLATFORM, KEY)).resolves.toMatchObject({ mode: 'stop', source: 'exempt' });
  });

  it('every quota key at once', async () => {
    const all = await resellerOveragesOf(overageTx({ platform: { [KEY]: priced('2') } }) as never, RESELLER);
    expect([...all.keys()]).toEqual(RESELLER_QUOTA_KEYS);
    expect(all.get(KEY)).toMatchObject({ mode: 'overage', source: 'platform' });
  });
});

describe('resellerLimitOf', () => {
  it('is the code default with no row at any level', async () => {
    await expect(resellerLimitOf(fakeTx({}) as never, RESELLER, 'custom_domains_max')).resolves.toEqual({ limit: 5, source: 'default' });
  });

  it('the reseller over its package over the platform', async () => {
    const all = { platform: { custom_domains_max: 3 }, pkg: { custom_domains_max: 8 }, own: { custom_domains_max: 12 } };
    await expect(resellerLimitOf(fakeTx({ platform: all.platform }) as never, RESELLER, 'custom_domains_max')).resolves.toEqual({ limit: 3, source: 'platform' });
    await expect(resellerLimitOf(fakeTx({ platform: all.platform, pkg: all.pkg }) as never, RESELLER, 'custom_domains_max')).resolves.toEqual({ limit: 8, source: 'package' });
    await expect(resellerLimitOf(fakeTx(all) as never, RESELLER, 'custom_domains_max')).resolves.toEqual({ limit: 12, source: 'reseller' });
  });

  it('a lower level may lower it too: the most specific wins, not the largest', async () => {
    await expect(resellerLimitOf(fakeTx({ platform: { custom_domains_max: 10 }, own: { custom_domains_max: 1 } }) as never, RESELLER, 'custom_domains_max')).resolves.toEqual({
      limit: 1,
      source: 'reseller',
    });
  });

  it('a null row is no limit, and stops the search', async () => {
    await expect(resellerLimitOf(fakeTx({ platform: { custom_domains_max: 3 }, pkg: { custom_domains_max: null } }) as never, RESELLER, 'custom_domains_max')).resolves.toEqual({
      limit: null,
      source: 'package',
    });
  });

  it('skips the package level for a reseller with no subscription', async () => {
    await expect(resellerLimitOf(fakeTx({ packageId: null, pkg: { custom_domains_max: 9 } }) as never, RESELLER, 'custom_domains_max')).resolves.toEqual({ limit: 5, source: 'default' });
  });

  it('bounds nothing but a reseller: the platform\'s own tenant has no limits', async () => {
    await expect(resellerLimitOf(fakeTx({ tenantType: 'platform_owner', own: { custom_domains_max: 1 } }) as never, PLATFORM, 'custom_domains_max')).resolves.toEqual({
      limit: null,
      source: 'exempt',
    });
  });
});

describe('resellerLimitsOf', () => {
  it('answers every key at once, each from its own level', async () => {
    const view = await resellerLimitsOf(fakeTx({ platform: { user_metered_cap_max: 10 }, own: { custom_domains_max: null } }) as never, RESELLER);
    expect(view).toEqual(
      expect.arrayContaining([
        { key: 'user_metered_cap_max', limit: 10, source: 'platform' },
        { key: 'custom_domains_max', limit: null, source: 'reseller' },
        { key: 'admin_issues_30d_max', limit: 50, source: 'default' },
        { key: 'platform_open_grants_max', limit: 500, source: 'default' },
      ]),
    );
    expect(view).toHaveLength(RESELLER_LIMIT_KEYS.length);
  });
});

describe('assertUnderLimit', () => {
  it('passes below the limit and with none; refuses at it with the figures', () => {
    expect(() => assertUnderLimit('custom_domains_max', { limit: 3, source: 'platform' }, 2)).not.toThrow();
    expect(() => assertUnderLimit('custom_domains_max', { limit: null, source: 'reseller' }, 10_000)).not.toThrow();
    let err: unknown;
    try {
      assertUnderLimit('custom_domains_max', { limit: 3, source: 'package' }, 3);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ResellerLimitReached);
    expect(err).toMatchObject({ reason: 'reseller_limit_reached', key: 'custom_domains_max', limit: 3, used: 3 });
  });
});
