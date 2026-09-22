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
 *    not a top-up, which is the arithmetic legacy got wrong (`contract.history.md`).
 */
import { LedgerDirection, PaymentStatus, WalletReasonType } from '@prisma/client';
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

/** A decimal as Prisma answers one: `toFixed` is all this code asks of it. */
const dec = (v: string) => ({ toFixed: (n: number) => Number(v).toFixed(n) });

/** What a ledger call saw: its arguments, and the tenant in scope when it ran. */
type Seen = { what: string; args: any; scope: string | undefined };

function build(
  rows: {
    sales?: { reasonType: WalletReasonType; sum: string; count: number }[];
    refunds?: { reasonType: WalletReasonType; sum: string }[];
    topUps?: { sum: string | null; count: number };
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
    _sum: { amount: dec(r.sum) },
    _count: { _all: r.count },
  }));
  const refunds = (rows.refunds ?? []).map((r) => ({ reasonType: r.reasonType, _sum: { amount: dec(r.sum) } }));
  const topUps = rows.topUps ?? { sum: null, count: 0 };

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
    paymentTransaction: {
      aggregate: record('topUps', {
        _sum: { amountCredited: topUps.sum === null ? null : dec(topUps.sum) },
        _count: { _all: topUps.count },
      }),
    },
  };
  const prisma = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };

  return { seen, service: new ResellerRevenueService(prisma as never, access) };
}

describe('ResellerRevenueService.totals', () => {
  it('answers the sales total from the sale debits, as a base-currency decimal string', async () => {
    const { service } = build({
      sales: [{ reasonType: WalletReasonType.traffic_consumption, sum: '1250.5', count: 7 }],
      topUps: { sum: '4000', count: 12 },
    });

    const total = await service.totals(owner, RESELLER, { from: FROM, to: TO });

    expect(total.sales.total).toBe('1250.50');
    expect(total.sales.count).toBe(7);
    expect(total.sales.byReason).toEqual([
      { reasonType: WalletReasonType.traffic_consumption, total: '1250.50', count: 7 },
    ]);
    // Money in, beside the sales figure and never folded into it.
    expect(total.topUps).toEqual({ total: '4000.00', count: 12 });
    expect(total.from).toBe(FROM.toISOString());
    expect(total.to).toBe(TO.toISOString());
  });

  it('answers zero rather than null when the period holds nothing', async () => {
    const { service } = build();
    const total = await service.totals(owner, RESELLER, { from: FROM, to: TO });
    expect(total.sales).toEqual({ total: '0.00', count: 0, byReason: [] });
    expect(total.topUps).toEqual({ total: '0.00', count: 0 });
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
    expect(where.reasonType.in).toEqual([WalletReasonType.traffic_consumption]);
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
    expect(where.reasonType.in).toEqual([WalletReasonType.traffic_refund]);
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
});
