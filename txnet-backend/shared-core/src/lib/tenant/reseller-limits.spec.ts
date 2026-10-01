/**
 * Reseller limits at three levels (ADR-0106, F-019-m): the reseller's own, its
 * package's, the platform's — else the code default. What breaks quietly:
 *
 *  - **the wrong level wins.** The most specific row wins, and a row whose
 *    value is `null` is "no limit", not "not set here": it stops the search;
 *  - **the platform bounded by itself.** Only a reseller has limits; the
 *    platform's own tenant (and any other kind) answers no limit;
 *  - **a reseller with no package.** It skips that level, never errors;
 *  - **a refusal with no figures.** It carries the key, the limit and the use.
 */
import {
  assertUnderLimit,
  RESELLER_LIMIT_KEYS,
  RESELLER_LIMITS,
  ResellerLimitReached,
  resellerLimitOf,
  resellerLimitsOf,
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
    expect([...RESELLER_LIMIT_KEYS].sort()).toEqual(['admin_issues_30d_max', 'custom_domains_max', 'platform_open_grants_max', 'staff_members_max', 'user_metered_cap_max']);
    for (const key of RESELLER_LIMIT_KEYS) {
      const def = RESELLER_LIMITS[key];
      expect(def.default === null || (def.default >= 0 && def.default <= def.max)).toBe(true);
    }
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
