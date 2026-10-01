/**
 * Quota terms locked per subscription period (ADR-0107 point 8, F-019-v3;
 * user 2026-10-01: a change in the reseller's favour applies at once, one
 * against it from the next period, and the period is the paid one — a year
 * for a yearly plan). What breaks quietly:
 *
 *  - **a mid-period cut.** The platform lowers a package's number or raises
 *    its price; a reseller that paid for the period keeps what it started with;
 *  - **a lock taken late.** The terms frozen are the ones in force before the
 *    first change, not after it — and a second change never re-freezes;
 *  - **a gift held back.** A larger number, a lower price or overage where
 *    there was a stop reaches the reseller at once, part by part;
 *  - **a lock that outlives its period.** A renewal moves `currentPeriodEnd`,
 *    and the next period reads the live terms;
 *  - **the wrong resellers frozen.** A package change locks only that
 *    package's subscribers; a reseller with no subscription has no period.
 */
import { Prisma, QuotaOverageMode } from '@prisma/client';

import { kinderQuotaTerms, lockQuotaTerms } from './quota-terms-lock';
import { quotaTermsOf } from './reseller-quota';

const KEY = 'campaign_sends_daily_max';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const GOLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SILVER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const END = new Date('2026-10-31T09:00:00Z');

type Row = Record<string, unknown> & { tenantId?: unknown; key?: unknown; periodEnd?: unknown; currentPeriodEnd?: unknown };

/** `where` as the code under test writes it: equality, `{in: [...]}`, and nested AND of fields. */
function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([field, cond]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && 'in' in (cond as Row)) return ((cond as { in: unknown[] }).in).includes(row[field]);
    if (cond instanceof Date) return row[field] instanceof Date && (row[field] as Date).getTime() === cond.getTime();
    return row[field] === cond;
  });
}

function table(rows: Row[]) {
  return {
    rows,
    findMany: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where)),
    findUnique: async ({ where }: { where: Row }) => {
      const flat = Object.assign({}, ...Object.values(where).map((v) => (v && typeof v === 'object' && !(v instanceof Date) ? v : {})), ...Object.entries(where).filter(([, v]) => !(v && typeof v === 'object') || v instanceof Date).map(([k, v]) => ({ [k]: v })));
      return rows.find((r) => matches(r, flat)) ?? null;
    },
    createMany: async ({ data, skipDuplicates }: { data: Row[]; skipDuplicates?: boolean }) => {
      let count = 0;
      for (const d of data) {
        const dup = rows.some((r) => r.tenantId === d.tenantId && r.key === d.key && (r.periodEnd as Date).getTime() === (d.periodEnd as Date).getTime());
        if (dup && skipDuplicates) continue;
        if (dup) throw new Error('unique violation');
        rows.push({ ...d });
        count++;
      }
      return { count };
    },
  };
}

const price = (p: string) => new Prisma.Decimal(p);
const overage = (p: string) => ({ mode: QuotaOverageMode.overage, unitPrice: price(p), currencyCode: 'USD' });
const stop = { mode: QuotaOverageMode.stop, unitPrice: null, currencyCode: null };

/** Three resellers: A and B on Gold, C on Silver; Gold includes 10 a day and sells past it at 0.50. */
function world() {
  const subs = table([
    { tenantId: A, packageId: GOLD, currentPeriodEnd: END },
    { tenantId: B, packageId: GOLD, currentPeriodEnd: END },
    { tenantId: C, packageId: SILVER, currentPeriodEnd: END },
  ]);
  const tenants = table([A, B, C].map((id) => ({ id, tenantType: 'reseller', deletedAt: null })));
  const packageLimit = table([
    { packageId: GOLD, key: KEY, value: 10 },
    { packageId: SILVER, key: KEY, value: 5 },
  ]);
  const packageQuotaOverage = table([{ packageId: GOLD, key: KEY, ...overage('0.50') }]);
  const locks = table([]);
  const tx = {
    tenant: tenants,
    tenantSubscription: subs,
    resellerLimit: table([]),
    packageLimit,
    resellerLimitSetting: table([]),
    resellerQuotaOverage: table([]),
    packageQuotaOverage,
    quotaOverageSetting: table([]),
    resellerQuotaTermsLock: locks,
  } as unknown as Prisma.TransactionClient;
  const setGold = (patch: Row) => Object.assign(packageLimit.rows[0], patch);
  const setGoldOverage = (patch: Row) => Object.assign(packageQuotaOverage.rows[0], patch);
  return { tx, subs, locks, setGold, setGoldOverage };
}

const termsOf = async (tx: Prisma.TransactionClient, tenantId: string) => {
  const t = await quotaTermsOf(tx, tenantId, KEY);
  return { included: t?.included, mode: t?.overage.mode, unitPrice: t?.overage.unitPrice?.toFixed(2) ?? null };
};

describe('kinderQuotaTerms (user 2026-10-01: in the reseller\'s favour at once, against it next period)', () => {
  const live = { included: 10, includedSource: 'package' as const, overage: { mode: 'overage' as const, unitPrice: price('0.50'), currencyCode: 'USD' }, overageSource: 'package' as const };

  it('each part on its own: the larger number, the lower price', () => {
    const locked = { ...live, included: 20, overage: { ...live.overage, unitPrice: price('0.80') } };
    const t = kinderQuotaTerms(locked, live);
    expect(t.included).toBe(20);
    expect(t.overage.unitPrice?.toFixed(2)).toBe('0.50');
  });

  it('no limit is the most a number can be; overage is kinder than a stop', () => {
    const t = kinderQuotaTerms({ ...live, included: null, overage: { mode: 'stop', unitPrice: null, currencyCode: null } }, live);
    expect(t.included).toBeNull();
    expect(t.overage).toMatchObject({ mode: 'overage', currencyCode: 'USD' });
  });

  it('no lock is the live terms', () => {
    expect(kinderQuotaTerms(null, live)).toBe(live);
  });
});

describe('lockQuotaTerms + quotaTermsOf (ADR-0107 point 8)', () => {
  it('a package cut waits for the period: the lock freezes the terms in force before the change', async () => {
    const w = world();
    expect(await lockQuotaTerms(w.tx, { packageId: GOLD })).toBe(2);
    w.setGold({ value: 4 });
    w.setGoldOverage({ unitPrice: price('0.90') });
    expect(await termsOf(w.tx, A)).toEqual({ included: 10, mode: 'overage', unitPrice: '0.50' });
    // Silver's subscriber was not frozen.
    expect(w.locks.rows.map((r) => r.tenantId).sort()).toEqual([A, B]);
  });

  it('a second change does not re-freeze: the period keeps the terms it started with', async () => {
    const w = world();
    await lockQuotaTerms(w.tx, { packageId: GOLD });
    w.setGold({ value: 4 });
    expect(await lockQuotaTerms(w.tx, { packageId: GOLD })).toBe(0);
    w.setGold({ value: 2 });
    expect((await termsOf(w.tx, B)).included).toBe(10);
  });

  it('a raise and a lower price reach the reseller at once', async () => {
    const w = world();
    await lockQuotaTerms(w.tx, { packageId: GOLD });
    w.setGold({ value: 20 });
    w.setGoldOverage({ unitPrice: price('0.30') });
    expect(await termsOf(w.tx, A)).toEqual({ included: 20, mode: 'overage', unitPrice: '0.30' });
  });

  it('a stop where there was overage waits; overage where there was a stop is at once', async () => {
    const w = world();
    await lockQuotaTerms(w.tx, { everyReseller: true });
    w.setGoldOverage(stop);
    expect((await termsOf(w.tx, A)).mode).toBe('overage');
    // C started the period at stop (Silver has no row); overage given to it now applies at once.
    (w.tx as unknown as { resellerQuotaOverage: { rows: Row[] } }).resellerQuotaOverage.rows.push({ tenantId: C, key: KEY, ...overage('0.70') });
    expect(await termsOf(w.tx, C)).toEqual({ included: 5, mode: 'overage', unitPrice: '0.70' });
  });

  it('a renewal ends the lock: the next period reads the live terms', async () => {
    const w = world();
    await lockQuotaTerms(w.tx, { tenantIds: [A] });
    w.setGold({ value: 4 });
    expect((await termsOf(w.tx, A)).included).toBe(10);
    w.subs.rows[0].currentPeriodEnd = new Date('2026-11-30T09:00:00Z');
    expect((await termsOf(w.tx, A)).included).toBe(4);
  });

  it('a reseller with no subscription has no period to lock', async () => {
    const w = world();
    w.subs.rows.splice(2, 1);
    expect(await lockQuotaTerms(w.tx, { tenantIds: [C] })).toBe(0);
  });
});
