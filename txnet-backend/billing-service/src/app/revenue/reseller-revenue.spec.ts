/**
 * A reseller's own revenue (F-311-b, ADR-0067): totals over a period for the
 * reseller the **path** names, read from the ledgers that already exist.
 *
 * There is one rule, and every case below is a way it breaks silently:
 * **the scope is the whole filter.** `ResellerAccess` (tenant invariant 21)
 * says whether this caller may read that reseller's figures, opens the
 * reseller's tenant scope, and only then is a ledger asked anything. Both
 * tables this reads are strict under RLS (`20260909001500`, list C) *and*
 * registered in `TENANT_SCOPED_MODELS`, so a query that names no tenant is
 * already the reseller's — and a query that names one by hand is a filter that
 * can be written wrong. The ways it goes wrong are all quiet:
 *
 *  - **a refusal reads nothing.** `admit` throws before the work starts, so a
 *    stranger never reaches a `groupBy`;
 *  - **the reseller is the path's, never the session's.** Its owner signs in to
 *    the *platform owner's* tenant (ADR-0059), so the ambient `X-Tenant-Id`
 *    would total the platform's own ledgers and call them the reseller's;
 *  - **a sale is a debit with a sale reason, not any debit.** A wallet-to-wallet
 *    transfer and an operator's correction move money without anything being
 *    sold; counting them is a revenue figure that grows when nobody bought;
 *  - **money in is not revenue.** The top-up figure is answered beside the sales
 *    one and never folded into it (ADR-0067 decision 1);
 *  - **only a settled payment is money.** A `pending` or `failed` attempt is
 *    not a top-up, which is the arithmetic legacy got wrong (`contract.history.md`);
 *  - **each currency is totalled on its own** (F-116-h8, ADR-0098 part 3): a
 *    row written before the reseller changed currency is converted through its
 *    `currency_change` rows into the currency it keeps now — never added to the
 *    new one as written, which would report dollars and rials as one number.
 */
import { LedgerDirection, PaymentStatus, Prisma, WalletReasonType } from '@prisma/client';
import { ResellerAccess, TenantContext } from '@txnet-backend/shared-core';

import { ResellerRevenueRefused, ResellerRevenueService } from './reseller-revenue.service';

const PLATFORM = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const OWNER_USER = '44444444-4444-4444-8444-444444444444';
const STRANGER = '55555555-5555-4555-8555-555555555555';

const owner = { userId: OWNER_USER, tenantId: PLATFORM, permissions: [] as string[] };
const stranger = { userId: STRANGER, tenantId: PLATFORM, permissions: [] as string[] };

const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-09-30T00:00:00.000Z');

/** What a ledger call saw: its arguments, and the tenant in scope when it ran. */
type Seen = { what: string; args: any; scope: string | undefined };

function build(
  rows: {
    sales?: { reasonType: WalletReasonType; sum: string; count: number; currencyCode?: string }[];
    refunds?: { reasonType: WalletReasonType; sum: string; currencyCode?: string }[];
    topUps?: { sum: string | null; count: number; currencyCode?: string }[];
    /** The reseller's operating currency now. */
    currencyCode?: string;
    changes?: { fromCode: string; toCode: string; rate: string }[];
  } = {},
) {
  const seen: Seen[] = [];
  const record = (what: string, answer: unknown) => async (args: unknown) => {
    seen.push({ what, args, scope: TenantContext.currentOrNull()?.id });
    return answer;
  };

  const tenants: Record<string, unknown> = {
    [PLATFORM]: { id: PLATFORM, slug: 'platform', tenantType: 'platform_owner', ownerUserId: null, status: 'active', graceEndsAt: null, deletedAt: null },
    [RESELLER]: { id: RESELLER, slug: 'acme', tenantType: 'reseller', ownerUserId: OWNER_USER, status: 'active', graceEndsAt: null, deletedAt: null },
    [OTHER]: { id: OTHER, slug: 'other', tenantType: 'reseller', ownerUserId: STRANGER, status: 'active', graceEndsAt: null, deletedAt: null },
  };
  const access = new ResellerAccess({
    tenant: {
      findUnique: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => tenants[where.id] ?? null,
    },
    tenantStaffMember: { findFirst: async () => null },
  } as never);

  const sales = (rows.sales ?? []).map((r) => ({
    reasonType: r.reasonType,
    currencyCode: r.currencyCode ?? 'USD',
    _sum: { amount: new Prisma.Decimal(r.sum) },
    _count: { _all: r.count },
  }));
  const refunds = (rows.refunds ?? []).map((r) => ({
    reasonType: r.reasonType,
    currencyCode: r.currencyCode ?? 'USD',
    _sum: { amount: new Prisma.Decimal(r.sum) },
  }));
  const topUps = (rows.topUps ?? []).map((r) => ({
    currencyCode: r.currencyCode ?? 'USD',
    _sum: { amountCredited: r.sum === null ? null : new Prisma.Decimal(r.sum) },
    _count: { _all: r.count },
  }));
  const places: Record<string, number> = { USD: 2, IRR: 0, EUR: 2 };

  const tx = {
    // `tenantTransaction` binds the scope with this as its first statement.
    $executeRaw: async () => 1,
    walletTransaction: {
      // The two reads of this table are told apart by their direction, as the
      // service asks them: the sale debits, then the credits that undo one.
      groupBy: async (args: any) => {
        const debit = args.where.direction === LedgerDirection.debit;
        return record(debit ? 'sales' : 'refunds', debit ? sales : refunds)(args);
      },
    },
    paymentTransaction: { groupBy: record('topUps', topUps) },
    // The reseller's currency now, and the changes that led to it (F-116-f).
    tenant: { findUnique: async () => ({ operatingCurrencyCode: rows.currencyCode ?? 'USD' }) },
    currency: {
      findUnique: async ({ where }: { where: { code: string } }) =>
        where.code in places ? { decimalPlaces: places[where.code] } : null,
    },
    currencyChange: {
      findMany: async () => (rows.changes ?? []).map((c) => ({ ...c, rate: new Prisma.Decimal(c.rate) })),
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };

  return { seen, service: new ResellerRevenueService(prisma as never, access) };
}

describe('ResellerRevenueService.totals', () => {
  it('answers the sales total from the sale debits, as a base-currency decimal string', async () => {
    const { service } = build({
      sales: [{ reasonType: WalletReasonType.traffic_consumption, sum: '1250.5', count: 7 }],
      topUps: [{ sum: '4000', count: 12 }],
    });

    const total = await service.totals(owner, RESELLER, { from: FROM, to: TO });

    expect(total.currencyCode).toBe('USD');
    expect(total.sales.total).toBe('1250.50');
    expect(total.sales.count).toBe(7);
    expect(total.sales.byReason).toEqual([
      { reasonType: WalletReasonType.traffic_consumption, total: '1250.50', count: 7 },
    ]);
    // Money in, beside the sales figure and never folded into it.
    expect(total.topUps).toEqual({ total: '4000.00', count: 12, byCurrency: [{ currencyCode: 'USD', total: '4000.00', count: 12 }] });
    expect(total.from).toBe(FROM.toISOString());
    expect(total.to).toBe(TO.toISOString());
  });

  it('answers zero rather than null when the period holds nothing', async () => {
    const { service } = build();
    const total = await service.totals(owner, RESELLER, { from: FROM, to: TO });
    expect(total.sales).toEqual({ total: '0.00', count: 0, byReason: [], byCurrency: [] });
    expect(total.topUps).toEqual({ total: '0.00', count: 0, byCurrency: [] });
  });

  it('reads both ledgers inside the reseller"s scope, and names no tenant in either query', async () => {
    const { seen, service } = build();
    await service.totals(owner, RESELLER, { from: FROM, to: TO });

    expect(seen.map((s) => s.what)).toEqual(['sales', 'refunds', 'topUps']);
    for (const call of seen) {
      // The scope, not a hand-written filter, is what makes these the
      // reseller's rows — and it is the reseller the path named.
      expect(call.scope).toBe(RESELLER);
      expect(JSON.stringify(call.args)).not.toContain('tenantId');
    }
  });

  it('counts a sale debit and nothing else', async () => {
    const { seen, service } = build();
    await service.totals(owner, RESELLER, { from: FROM, to: TO });

    const where = seen[0].args.where;
    expect(where.direction).toBe(LedgerDirection.debit);
    expect(where.reasonType.in).toEqual([WalletReasonType.traffic_consumption, WalletReasonType.product_purchase]);
    // A transfer between two of this reseller's users sells nothing; an
    // operator's correction is not a sale either.
    expect(where.reasonType.in).not.toContain(WalletReasonType.wallet_transfer_out);
    expect(where.reasonType.in).not.toContain(WalletReasonType.admin_manual_adjust);
    expect(where.createdAt).toEqual({ gte: FROM, lte: TO });
  });

  it('counts only a settled top-up, and not the reseller"s own payment to the platform', async () => {
    const { seen, service } = build();
    await service.totals(owner, RESELLER, { from: FROM, to: TO });

    const where = seen.find((c) => c.what === 'topUps')!.args.where;
    expect(where.status).toBe(PaymentStatus.success);
    // F-019-b: a row with `billingTenantId` is the reseller topping up its own
    // billing wallet with the platform — money out, and never its revenue.
    expect(where.billingTenantId).toBeNull();
    expect(where.createdAt).toEqual({ gte: FROM, lte: TO });
  });

  it('takes the traffic refunded back off the sale it came from (F-027-r)', async () => {
    const { seen, service } = build({
      sales: [{ reasonType: WalletReasonType.traffic_consumption, sum: '100.00', count: 40 }],
      refunds: [{ reasonType: WalletReasonType.traffic_refund, sum: '12.50' }],
    });

    const total = await service.totals(owner, RESELLER, { from: FROM, to: TO });

    // The blocks were bought ahead of consumption (ADR-0072); what the Grant
    // closed without serving went back, and was never this reseller's revenue.
    expect(total.sales.total).toBe('87.50');
    expect(total.sales.byReason).toEqual([
      { reasonType: WalletReasonType.traffic_consumption, total: '87.50', count: 40 },
    ]);
    // The rows still exist and were still sold: it is the money that came back.
    expect(total.sales.count).toBe(40);

    const where = seen.find((c) => c.what === 'refunds')!.args.where;
    expect(where.direction).toBe(LedgerDirection.credit);
    expect(where.reasonType.in).toEqual([WalletReasonType.traffic_refund, WalletReasonType.product_refund]);
  });

  it('reports a close whose blocks were bought before the window, rather than dropping it', async () => {
    const { service } = build({ refunds: [{ reasonType: WalletReasonType.traffic_refund, sum: '3.00' }] });

    const total = await service.totals(owner, RESELLER, { from: FROM, to: TO });

    // Negative, not clamped: money left in this window and a figure of zero
    // would be one no rows back.
    expect(total.sales.total).toBe('-3.00');
    expect(total.sales.byReason).toEqual([
      { reasonType: WalletReasonType.traffic_consumption, total: '-3.00', count: 0 },
    ]);
  });

  it('refuses a caller who does not administer that reseller, before reading anything', async () => {
    const { seen, service } = build();
    await expect(service.totals(stranger, RESELLER, { from: FROM, to: TO })).rejects.toMatchObject({
      name: 'ResellerRevenueRefused',
      reason: 'not_allowed',
    });
    expect(seen).toEqual([]);
  });

  it('refuses the owner of another reseller the same way', async () => {
    const { seen, service } = build();
    await expect(service.totals(owner, OTHER, { from: FROM, to: TO })).rejects.toBeInstanceOf(
      ResellerRevenueRefused,
    );
    expect(seen).toEqual([]);
  });

  it('totals each currency on its own, then converts the old one through the reseller’s change into its currency now (F-116-h8)', async () => {
    // Sold in dollars until the reseller moved to rials at 1 USD = 600000 IRR.
    const { seen, service } = build({
      currencyCode: 'IRR',
      changes: [{ fromCode: 'USD', toCode: 'IRR', rate: '600000' }],
      sales: [
        { reasonType: WalletReasonType.product_purchase, sum: '10.00', count: 2, currencyCode: 'USD' },
        { reasonType: WalletReasonType.product_purchase, sum: '3000000', count: 1, currencyCode: 'IRR' },
      ],
      refunds: [{ reasonType: WalletReasonType.product_refund, sum: '2.50', currencyCode: 'USD' }],
      topUps: [
        { sum: '20.00', count: 1, currencyCode: 'USD' },
        { sum: '6000000', count: 3, currencyCode: 'IRR' },
      ],
    });

    const total = await service.totals(owner, RESELLER, { from: FROM, to: TO });

    // Never 3000010 — the two currencies are summed apart, and the dollars converted.
    expect(total.currencyCode).toBe('IRR');
    expect(total.sales.total).toBe('7500000');
    expect(total.sales.count).toBe(3);
    expect(total.sales.byReason).toEqual([{ reasonType: WalletReasonType.product_purchase, total: '7500000', count: 3 }]);
    // What was written, per currency, net of what came back in that currency.
    expect(total.sales.byCurrency).toEqual([
      { currencyCode: 'IRR', total: '3000000.00', count: 1 },
      { currencyCode: 'USD', total: '7.50', count: 2 },
    ]);
    expect(total.topUps.total).toBe('18000000');
    expect(total.topUps.count).toBe(4);
    expect(total.topUps.byCurrency).toEqual([
      { currencyCode: 'IRR', total: '6000000.00', count: 3 },
      { currencyCode: 'USD', total: '20.00', count: 1 },
    ]);

    // Grouped by currency in the query — a sum across currencies is never asked for.
    for (const call of seen) expect(call.args.by).toContain('currencyCode');
  });

  it('leaves a converted total empty, never summed as written, when no change of the reseller leads from a currency', async () => {
    const { service } = build({
      currencyCode: 'IRR',
      sales: [
        { reasonType: WalletReasonType.product_purchase, sum: '10.00', count: 1, currencyCode: 'EUR' },
        { reasonType: WalletReasonType.product_purchase, sum: '500000', count: 1, currencyCode: 'IRR' },
      ],
      topUps: [{ sum: '500000', count: 1, currencyCode: 'IRR' }],
    });

    const total = await service.totals(owner, RESELLER, { from: FROM, to: TO });

    expect(total.sales.total).toBeNull();
    expect(total.sales.byReason).toEqual([{ reasonType: WalletReasonType.product_purchase, total: null, count: 2 }]);
    expect(total.sales.byCurrency).toEqual([
      { currencyCode: 'EUR', total: '10.00', count: 1 },
      { currencyCode: 'IRR', total: '500000.00', count: 1 },
    ]);
    // A figure whose currencies all convert is still answered.
    expect(total.topUps.total).toBe('500000');
  });
});
