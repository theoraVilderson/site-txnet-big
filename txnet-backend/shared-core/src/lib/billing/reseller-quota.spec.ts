/**
 * The quota engine (ADR-0107 points 4-7, 10, 12; F-019-v2). What breaks quietly:
 *
 *  - **a period that drifts.** A day starts at 00:00 on the platform's clock
 *    (Tehran, +3:30), a week on Saturday, a month on the subscription's own
 *    day, clamped as the renewal clamps. A rolling window would make the
 *    statement unexplainable;
 *  - **half an act.** Past what is included, `stop`, an empty wallet, the
 *    reseller's spend cap or a price in a stale currency refuses the whole
 *    act and writes nothing: no usage row, no ledger row;
 *  - **a retry charged twice.** The same sourceRef answers the first row;
 *  - **overage on credit.** It is debited from the billing wallet at the
 *    act, and the row names the ledger entry;
 *  - **a give-back that keeps the money, or gives it twice.** Release
 *    returns the units to the period and the charge to the wallet, once;
 *  - **the platform counted.** A tenant that is not a reseller is exempt.
 */
import { Prisma } from '@prisma/client';

import { quotaPeriodAt } from './quota-period';
import { ResellerQuota, ResellerQuotaExhausted, ResellerQuotaSourceReleased, type QuotaMeterTerms } from './reseller-quota';

const RESELLER = '22222222-2222-4222-8222-222222222222';
const TEHRAN = 'Asia/Tehran';

describe('quotaPeriodAt (ADR-0107 point 7)', () => {
  it('a day is 00:00 to 00:00 on the platform clock: Tehran midnight is 20:30 UTC the evening before', () => {
    const p = quotaPeriodAt('day', new Date('2026-10-01T21:00:00Z'), TEHRAN); // 00:30 on Oct 2 in Tehran
    expect(p.start.toISOString()).toBe('2026-10-01T20:30:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-02T20:30:00.000Z');
    expect(quotaPeriodAt('day', new Date('2026-10-01T20:00:00Z'), TEHRAN).start.toISOString()).toBe('2026-09-30T20:30:00.000Z');
  });

  it('a week starts on Saturday, wherever in it now falls', () => {
    // 2026-10-01 is a Thursday in Tehran; its week began Saturday 2026-09-26.
    const p = quotaPeriodAt('week', new Date('2026-10-01T10:00:00Z'), TEHRAN);
    expect(p.start.toISOString()).toBe('2026-09-25T20:30:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-02T20:30:00.000Z');
    // Saturday 00:10 Tehran is already the new week.
    expect(quotaPeriodAt('week', new Date('2026-10-02T20:40:00Z'), TEHRAN).start.toISOString()).toBe('2026-10-02T20:30:00.000Z');
  });

  it('a month is the subscription month, stepped from its end and clamped as the renewal clamps', () => {
    const end = new Date('2026-10-31T09:00:00Z');
    const p = quotaPeriodAt('month', new Date('2026-10-15T00:00:00Z'), TEHRAN, end);
    expect([p.start.toISOString(), p.end.toISOString()]).toEqual(['2026-09-30T09:00:00.000Z', '2026-10-31T09:00:00.000Z']);
    // A yearly plan whose end is months away is split into its months.
    const yearly = quotaPeriodAt('month', new Date('2026-03-01T00:00:00Z'), TEHRAN, new Date('2026-12-31T00:00:00Z'));
    expect([yearly.start.toISOString(), yearly.end.toISOString()]).toEqual(['2026-02-28T00:00:00.000Z', '2026-03-31T00:00:00.000Z']);
    // Past an unpaid end, the months keep stepping forward from it.
    const late = quotaPeriodAt('month', new Date('2026-11-02T00:00:00Z'), TEHRAN, end);
    expect(late.start.toISOString()).toBe('2026-10-31T09:00:00.000Z');
  });

  it('no subscription: the calendar month on the platform clock', () => {
    const p = quotaPeriodAt('month', new Date('2026-10-15T00:00:00Z'), TEHRAN);
    expect([p.start.toISOString(), p.end.toISOString()]).toEqual(['2026-09-30T20:30:00.000Z', '2026-10-31T20:30:00.000Z']);
  });
});

type Usage = {
  id: string;
  tenantId: string;
  meter: string;
  sourceRef: string;
  periodStart: Date;
  periodEnd: Date;
  qty: number;
  includedQty: number;
  overageQty: number;
  unitPrice: Prisma.Decimal | null;
  overageAmount: Prisma.Decimal;
  currencyCode: string | null;
  chargeTransactionId: string | null;
  releasedAt: Date | null;
  refundTransactionId: string | null;
  createdAt: Date;
};

/** An in-memory database for the engine and the real `TenantBillingLedger` under it. */
function world(opts: { balance?: string; cap?: { amount: string; currencyCode?: string }; platformCurrency?: string; tenantType?: string } = {}) {
  const usage: Usage[] = [];
  const ledgerRows: Array<{ id: string; direction: string; reasonType: string; referenceId: string; amount: Prisma.Decimal }> = [];
  const wallet = { id: 'w1', tenantId: RESELLER, cachedBalance: new Prisma.Decimal(opts.balance ?? '100.00'), version: 0, currencyCode: 'USD' };
  const live = (where: { tenantId: string; meter?: string; releasedAt: null; currencyCode?: string; createdAt: { gte: Date; lt: Date } }) =>
    usage.filter(
      (u) =>
        u.tenantId === where.tenantId &&
        (!where.meter || u.meter === where.meter) &&
        u.releasedAt === null &&
        (!where.currencyCode || u.currencyCode === where.currencyCode) &&
        u.createdAt >= where.createdAt.gte &&
        u.createdAt < where.createdAt.lt,
    );
  let n = 0;
  const tx = {
    $executeRaw: async () => 1,
    tenant: {
      findUnique: async () => ({ tenantType: opts.tenantType ?? 'reseller' }),
      findFirst: async () => ({ id: 'platform', operatingCurrencyCode: opts.platformCurrency ?? 'USD' }),
    },
    tenantSubscriptionSetting: { findUnique: async () => ({ quotaTimeZone: TEHRAN }) },
    tenantSubscription: { findUnique: async () => null },
    resellerOverageCap: { findUnique: async () => (opts.cap ? { amount: new Prisma.Decimal(opts.cap.amount), currencyCode: opts.cap.currencyCode ?? 'USD' } : null) },
    resellerQuotaUsage: {
      findUnique: async ({ where }: { where: { tenantId_meter_sourceRef: { tenantId: string; meter: string; sourceRef: string } } }) => {
        const k = where.tenantId_meter_sourceRef;
        return usage.find((u) => u.tenantId === k.tenantId && u.meter === k.meter && u.sourceRef === k.sourceRef) ?? null;
      },
      aggregate: async ({ where }: { where: Parameters<typeof live>[0] }) => {
        const rows = live(where);
        return {
          _sum: {
            includedQty: rows.length ? rows.reduce((a, r) => a + r.includedQty, 0) : null,
            overageQty: rows.length ? rows.reduce((a, r) => a + r.overageQty, 0) : null,
            overageAmount: rows.length ? rows.reduce((a, r) => a.plus(r.overageAmount), new Prisma.Decimal(0)) : null,
          },
        };
      },
      create: async ({ data }: { data: Usage }) => {
        const row = { ...data, releasedAt: data.releasedAt ?? null, refundTransactionId: data.refundTransactionId ?? null };
        usage.push(row);
        return row;
      },
      findMany: async ({ where }: { where: { tenantId: string; sourceRef: string } }) =>
        usage.filter((u) => u.tenantId === where.tenantId && u.sourceRef === where.sourceRef && u.releasedAt === null).sort((a, b) => a.meter.localeCompare(b.meter)),
      updateMany: async ({ where, data }: { where: { id: string }; data: { releasedAt: Date } }) => {
        const row = usage.find((u) => u.id === where.id && u.releasedAt === null);
        if (!row) return { count: 0 };
        row.releasedAt = data.releasedAt;
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Usage> }) => Object.assign(usage.find((u) => u.id === where.id) as Usage, data),
    },
    // What resellerLimitOf / resellerOverageOf read: no rows, so the caller's terms come from `consumeMeter`.
    resellerLimit: { findMany: async () => [] },
    packageLimit: { findMany: async () => [] },
    resellerLimitSetting: { findMany: async () => [] },
    resellerQuotaOverage: { findMany: async () => [] },
    packageQuotaOverage: { findMany: async () => [] },
    quotaOverageSetting: { findMany: async () => [] },
    tenantBillingTransaction: {
      findFirst: async ({ where }: { where: { reasonType: string; referenceId: string } }) => ledgerRows.find((r) => r.reasonType === where.reasonType && r.referenceId === where.referenceId) ?? null,
      create: async ({ data }: { data: { direction: string; reasonType: string; referenceId: string; amount: Prisma.Decimal } }) => {
        const row = { id: `t${++n}`, walletId: wallet.id, ...data };
        ledgerRows.push(row);
        return row;
      },
    },
    tenantBillingWallet: {
      findUnique: async () => ({ ...wallet }),
      updateMany: async ({ data }: { data: { cachedBalance: Prisma.Decimal } }) => {
        wallet.cachedBalance = data.cachedBalance;
        wallet.version++;
        return { count: 1 };
      },
    },
    outboxEvent: { create: async () => ({ id: 'o' }) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, usage, ledgerRows, wallet };
}

const terms = (over: Partial<QuotaMeterTerms> = {}): QuotaMeterTerms => ({
  meter: 'campaign_sends_daily_max',
  period: 'day',
  included: 2,
  overage: { mode: 'overage', unitPrice: new Prisma.Decimal('0.50'), currencyCode: 'USD' },
  ...over,
});
const NOW = new Date('2026-10-01T10:00:00Z');
const consume = (tx: Prisma.TransactionClient, sourceRef: string, qty = 1, t = terms(), now = NOW) => ResellerQuota.consumeMeter(tx, { tenantId: RESELLER, terms: t, qty, sourceRef, now });
const stoppedBy = async (p: Promise<unknown>) => {
  const e = await p.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ResellerQuotaExhausted);
  return (e as ResellerQuotaExhausted).stoppedBy;
};

describe('ResellerQuota.consumeMeter', () => {
  it('counts what is included, then sells each further unit from the wallet at the act, naming the ledger entry', async () => {
    const { tx, usage, ledgerRows, wallet } = world();
    await expect(consume(tx, 'a')).resolves.toMatchObject({ includedQty: 1, overageQty: 0, currencyCode: null });
    const split = await consume(tx, 'b', 3);
    expect(split).toMatchObject({ exempt: false, includedQty: 1, overageQty: 2, currencyCode: 'USD', replay: false });
    expect(split.exempt === false && split.overageAmount.toFixed(2)).toBe('1.00');
    expect(wallet.cachedBalance.toFixed(2)).toBe('99.00');
    expect(ledgerRows).toEqual([expect.objectContaining({ direction: 'debit', reasonType: 'quota_overage_charge', referenceId: usage[1].id })]);
    expect(usage[1]).toMatchObject({ chargeTransactionId: ledgerRows[0].id, periodStart: new Date('2026-09-30T20:30:00Z'), periodEnd: new Date('2026-10-01T20:30:00Z') });
  });

  it('a new day starts with its included units again', async () => {
    const { tx } = world();
    await consume(tx, 'a', 2);
    await expect(consume(tx, 'b', 1, terms(), new Date('2026-10-01T21:00:00Z'))).resolves.toMatchObject({ includedQty: 1, overageQty: 0 });
  });

  it('the same act again answers the first row and charges nothing more', async () => {
    const { tx, ledgerRows, usage } = world();
    await consume(tx, 'a', 3);
    await expect(consume(tx, 'a', 3)).resolves.toMatchObject({ replay: true, overageQty: 1 });
    expect(usage).toHaveLength(1);
    expect(ledgerRows).toHaveLength(1);
  });

  it('stop, an empty wallet, the spend cap and a stale price each refuse the whole act and write nothing', async () => {
    const stop = world();
    await consume(stop.tx, 'a', 2, terms({ overage: { mode: 'stop', unitPrice: null, currencyCode: null } }));
    expect(await stoppedBy(consume(stop.tx, 'b', 1, terms({ overage: { mode: 'stop', unitPrice: null, currencyCode: null } })))).toBe('stop');
    expect(stop.usage).toHaveLength(1);

    const poor = world({ balance: '0.40' });
    expect(await stoppedBy(consume(poor.tx, 'a', 3))).toBe('wallet_empty');
    expect([poor.usage, poor.ledgerRows]).toEqual([[], []]);

    const capped = world({ cap: { amount: '1.00' } });
    await consume(capped.tx, 'a', 4); // 2 included, 2 × 0.50 = the whole cap
    expect(await stoppedBy(consume(capped.tx, 'b', 1))).toBe('spend_cap');
    expect(capped.ledgerRows).toHaveLength(1);

    const stale = world({ platformCurrency: 'IRR' });
    expect(await stoppedBy(consume(stale.tx, 'a', 3))).toBe('price_unavailable');
    expect(stale.usage).toEqual([]);
  });

  it('a refusal carries the figures, never text the buyer would see', async () => {
    const { tx } = world();
    await consume(tx, 'a', 2, terms({ overage: { mode: 'stop', unitPrice: null, currencyCode: null } }));
    const e = (await consume(tx, 'b', 1, terms({ overage: { mode: 'stop', unitPrice: null, currencyCode: null } })).catch((x: unknown) => x)) as ResellerQuotaExhausted;
    expect(e.facts).toEqual({ meter: 'campaign_sends_daily_max', stoppedBy: 'stop', included: 2, used: 2 });
    expect(e.reason).toBe('reseller_quota_exhausted');
  });

  it('no limit counts every unit as included and never charges', async () => {
    const { tx, ledgerRows } = world();
    await expect(consume(tx, 'a', 500, terms({ included: null }))).resolves.toMatchObject({ includedQty: 500, overageQty: 0 });
    expect(ledgerRows).toEqual([]);
  });

  it('refuses a quantity that is not a whole number above zero', async () => {
    const { tx } = world();
    await expect(consume(tx, 'a', 0)).rejects.toThrow(/whole number/);
    await expect(consume(tx, 'a', 1.5)).rejects.toThrow(/whole number/);
  });
});

describe('ResellerQuota.release', () => {
  it('gives the units back to the period and the charge back to the wallet, once', async () => {
    const { tx, usage, ledgerRows, wallet } = world();
    await consume(tx, 'a', 3);
    await expect(ResellerQuota.release(tx, { tenantId: RESELLER, sourceRef: 'a', now: NOW })).resolves.toMatchObject({ released: 1 });
    expect(wallet.cachedBalance.toFixed(2)).toBe('100.00');
    expect(ledgerRows.map((r) => [r.direction, r.reasonType, r.referenceId])).toEqual([
      ['debit', 'quota_overage_charge', usage[0].id],
      ['credit', 'quota_overage_refund', usage[0].id],
    ]);
    expect(usage[0].refundTransactionId).toBe(ledgerRows[1].id);
    await expect(ResellerQuota.release(tx, { tenantId: RESELLER, sourceRef: 'a', now: NOW })).resolves.toEqual({ released: 0, refunded: [] });
    // The two included units are free again.
    await expect(consume(tx, 'b', 2)).resolves.toMatchObject({ includedQty: 2, overageQty: 0 });
  });

  it('a released act cannot consume again under the same reference', async () => {
    const { tx } = world();
    await consume(tx, 'a');
    await ResellerQuota.release(tx, { tenantId: RESELLER, sourceRef: 'a', now: NOW });
    await expect(consume(tx, 'a')).rejects.toBeInstanceOf(ResellerQuotaSourceReleased);
  });
});

describe('ResellerQuota.consume (a registry key)', () => {
  it('the platform\'s own tenant is exempt: nothing counted, nothing written', async () => {
    const { tx, usage } = world({ tenantType: 'platform_owner' });
    await expect(ResellerQuota.consume(tx, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', qty: 1, sourceRef: 'c1', now: NOW })).resolves.toEqual({ exempt: true });
    expect(usage).toEqual([]);
  });

  it('resolves the key\'s number and mode: the code default, 10 a day, then stop', async () => {
    const { tx } = world();
    await ResellerQuota.consume(tx, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', qty: 10, sourceRef: 'c1', now: NOW });
    expect(await stoppedBy(ResellerQuota.consume(tx, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', qty: 1, sourceRef: 'c2', now: NOW }))).toBe('stop');
  });
});

describe('ResellerQuota.statementOf', () => {
  it('says what is included, used and sold past this period, and what overage cost this month', async () => {
    const { tx } = world({ cap: { amount: '20.00' } });
    await ResellerQuota.consume(tx, { tenantId: RESELLER, meter: 'campaign_sends_daily_max', qty: 4, sourceRef: 'c1', now: NOW });
    const s = await ResellerQuota.statementOf(tx, RESELLER, 'campaign_sends_daily_max', NOW);
    expect(s).toMatchObject({ included: 10, includedUsed: 4, overageQty: 0, overageAmount: '0.00', overage: { mode: 'stop' }, spend: { cap: '20.00', spent: '0.00', currencyCode: 'USD' } });
  });
});
