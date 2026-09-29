import { GrantStatus, Prisma, SpendingCapPeriod, VariantBillingMode } from '@prisma/client';

import { OutboxEventType } from '@txnet-backend/shared-core';

import { reviveFundedGrants } from '../entitlement/revival';
import { CAP_REACHED, QUOTA_EXHAUSTED } from '../entitlement/suspension';
import { suspendIfExhausted } from '../traffic/exhaustion';
import { BlockPurchaseRefused, BlockPurchaseService, GIB } from '../traffic/block-purchase';
import { NO_VPN_RESERVE, VpnReserve, installVpnReserve } from '../traffic/vpn-reserve';
import { WalletHoldService, WalletLedgerService } from '../wallet/wallet-ledger.service';
import { NO_SPENDING_CAPS, SpendingCaps, installSpendingCaps, periodStart } from './cap-funding';
import { SpendingCapRefused, SpendingCapService } from './spending-cap';

/**
 * A spending cap on one product (F-118-i, ADR-0105 (9)).
 *
 * The invariant this file holds: **a capped Grant is never funded past
 * `cap − spent`** — neither a block debited for it nor money held for it —
 * while the owner's other products spend the rest of the wallet as before.
 * Reached, the product is cut exactly as an empty wallet cuts it; raised, it
 * comes back as a top-up brings it back.
 */
const D = (v: string | number) => new Prisma.Decimal(v);

type Num = Prisma.Decimal | { increment?: Prisma.Decimal | bigint; decrement?: Prisma.Decimal | bigint };
const apply = (v: Prisma.Decimal, n: Num) =>
  n instanceof Prisma.Decimal ? n : v.plus((n.increment ?? 0).toString()).minus((n.decrement ?? 0).toString());

type GrantRow = {
  id: string;
  tenantId: string;
  userId: string;
  status: GrantStatus;
  statusReason: string | null;
  suspendedAt: Date | null;
  endsAt: Date | null;
  billingMode: VariantBillingMode;
  /** Its prepaid `vpn.traffic` meter's `unitPrice`; null = no meter (F-118-l). */
  rate: Prisma.Decimal | null;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  consumedBytes: bigint;
  /** The meter's money cursor. */
  billed: bigint;
};

type CapRow = {
  id: string;
  tenantId: string;
  grantId: string;
  label: string;
  amount: Prisma.Decimal;
  currencyCode: string;
  period: SpendingCapPeriod;
  startsAt: Date;
  periodStartsAt: Date;
  spent: Prisma.Decimal;
};

function fakeStore() {
  const grants = new Map<string, GrantRow>();
  const caps: CapRow[] = [];
  const meters: Array<{ id: string; grantId: string }> = [];
  const wallet = { id: 'wallet-1', ownerUserId: 'user-1', currencyCode: 'USD', cachedBalance: D(0), heldAmount: D(0), version: 0 };
  const holds: Array<{ id: string; walletId: string; ownerRef: string; amount: Prisma.Decimal; captured: Prisma.Decimal; status: 'open' | 'closed'; currencyCode: string }> = [];
  const ledger: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  // `statusReason` as a `where` takes a value or `{ in: [...] }`.
  const reasonIs = (own: string | null, want: string | { in: string[] } | undefined) =>
    want === undefined || (typeof want === 'string' ? own === want : want.in.includes(own ?? ''));
  const matches = (c: CapRow, where: Partial<CapRow>) => Object.entries(where).every(([k, v]) => {
    const own = c[k as keyof CapRow];
    return own instanceof Date && v instanceof Date ? own.getTime() === v.getTime() : own === v;
  });

  const tx = {
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const g = grants.get(where.id);
        return g ? { ...g } : null;
      },
      findMany: async ({ where }: { where: { userId: string; status: GrantStatus; statusReason: string | { in: string[] } } }) =>
        [...grants.values()].filter((g) => g.userId === where.userId && g.status === where.status && reasonIs(g.statusReason, where.statusReason))
          .map((g) => ({ ...g, meters: g.rate ? [{ unitPrice: g.rate, currencyCode: 'USD' }] : [] })),
      update: async ({ where, data }: { where: { id: string }; data: { purchasedBytes: { increment: bigint } } }) => {
        const g = grants.get(where.id)!;
        g.purchasedBytes += data.purchasedBytes.increment;
        return { ...g };
      },
      updateMany: async ({ where, data }: { where: { id: string; status: GrantStatus; statusReason?: string | { in: string[] } }; data: Partial<GrantRow> }) => {
        const g = grants.get(where.id);
        if (!g || g.status !== where.status || !reasonIs(g.statusReason, where.statusReason)) return { count: 0 };
        Object.assign(g, data);
        return { count: 1 };
      },
    },
    grantMeter: {
      // A metered Grant's prepaid vpn.traffic meter (F-118-l), id = the Grant's.
      findUnique: async ({ where }: { where: { grantId_meterKey: { grantId: string } } }) => {
        const g = grants.get(where.grantId_meterKey.grantId);
        return g?.rate ? { id: g.id, mode: 'prepaid', unitPrice: g.rate, currencyCode: 'USD', billed: g.billed } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { billed: { increment: bigint } } }) => {
        const g = grants.get(where.id)!;
        g.billed += data.billed.increment;
        return { billed: g.billed };
      },
      findMany: async ({ where }: { where: { grantId: string } }) => meters.filter((m) => m.grantId === where.grantId).map((m) => ({ id: m.id })),
    },
    config: { updateMany: async () => ({ count: 1 }) },
    spendingCap: {
      findUnique: async ({ where }: { where: { grantId: string } }) => {
        const c = caps.find((r) => r.grantId === where.grantId);
        return c ? { ...c } : null;
      },
      create: async ({ data }: { data: Omit<CapRow, 'id' | 'spent'> & { spent?: Prisma.Decimal } }) => {
        const row = { id: `cap-${caps.length + 1}`, spent: D(0), ...data };
        caps.push(row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { grantId: string }; data: Partial<CapRow> }) => {
        const c = caps.find((r) => r.grantId === where.grantId)!;
        Object.assign(c, data);
        return { ...c };
      },
      updateMany: async ({ where, data }: { where: Partial<CapRow>; data: Partial<Omit<CapRow, 'spent'>> & { spent?: Num } }) => {
        const hit = caps.filter((c) => matches(c, where));
        for (const c of hit) {
          const { spent, ...rest } = data;
          Object.assign(c, rest);
          if (spent) c.spent = apply(c.spent, spent);
        }
        return { count: hit.length };
      },
      deleteMany: async ({ where }: { where: { grantId: string } }) => {
        const before = caps.length;
        caps.splice(0, caps.length, ...caps.filter((c) => c.grantId !== where.grantId));
        return { count: before - caps.length };
      },
    },
    wallet: {
      findUnique: async ({ where }: { where: { ownerUserId: string } }) => (where.ownerUserId === wallet.ownerUserId ? { ...wallet } : null),
      updateMany: async ({ where, data }: { where: { id: string; version: number }; data: { cachedBalance?: Prisma.Decimal; heldAmount?: Prisma.Decimal; version: { increment: number } } }) => {
        if (where.id !== wallet.id || where.version !== wallet.version) return { count: 0 };
        if (data.cachedBalance) wallet.cachedBalance = data.cachedBalance;
        if (data.heldAmount) wallet.heldAmount = data.heldAmount;
        wallet.version += data.version.increment;
        return { count: 1 };
      },
    },
    walletHold: {
      findFirst: async ({ where }: { where: { walletId: string; ownerRef: string; status: 'open' } }) => {
        const h = holds.find((r) => r.walletId === where.walletId && r.ownerRef === where.ownerRef && r.status === where.status);
        return h ? { ...h } : null;
      },
      findMany: async ({ where }: { where: { walletId: string; status: 'open'; ownerRef: { in: string[] } } }) =>
        holds.filter((r) => r.walletId === where.walletId && r.status === where.status && where.ownerRef.in.includes(r.ownerRef)).map((h) => ({ ...h })),
      create: async ({ data }: { data: { walletId: string; ownerRef: string; amount: Prisma.Decimal; currencyCode: string } }) => {
        const row = { id: `hold-${holds.length + 1}`, captured: D(0), status: 'open' as const, ...data };
        holds.push(row);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: { id: string; status: 'open'; amount?: { gte: Prisma.Decimal } }; data: { amount?: Num; captured?: Num; status?: 'closed' } }) => {
        const h = holds.find((r) => r.id === where.id && r.status === where.status && (!where.amount || r.amount.gte(where.amount.gte)));
        if (!h) return { count: 0 };
        if (data.amount) h.amount = apply(h.amount, data.amount);
        if (data.captured) h.captured = apply(h.captured, data.captured);
        if (data.status) h.status = data.status;
        return { count: 1 };
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...holds.find((r) => r.id === where.id)! }),
    },
    walletTransaction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `ledger-${ledger.length + 1}`, ...data };
        ledger.push(row);
        return row;
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      },
    },
    // `suspendIfExhausted`'s locked read of the wallet: the free balance, this Grant's own reserve added back.
    $queryRaw: async (_sql: TemplateStringsArray, grantId: string) => {
      const own = holds.find((h) => h.ownerRef === grantId && h.status === 'open')?.amount ?? D(0);
      return [{ free: wallet.cachedBalance.minus(wallet.heldAmount).plus(own), own }];
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    wallet,
    holds,
    caps,
    meters,
    ledger,
    events,
    openHold: (ref: string) => holds.find((h) => h.ownerRef === ref && h.status === 'open')?.amount.toFixed(2) ?? null,
    fund(balance: string) {
      wallet.cachedBalance = D(balance);
    },
    grant(id: string, over: Partial<GrantRow> = {}) {
      grants.set(id, {
        id,
        tenantId: 'tenant-1',
        userId: 'user-1',
        status: GrantStatus.active,
        statusReason: null,
        suspendedAt: null,
        endsAt: null,
        billingMode: VariantBillingMode.metered,
        // 10.00 a GiB: the reserve of one GiB is 10.00.
        rate: D('10'),
        trafficUnlimited: false,
        purchasedBytes: BigInt(0),
        consumedBytes: BigInt(0),
        billed: BigInt(0),
        ...over,
      });
      return grants.get(id)!;
    },
    cap(grantId: string, amount: string, over: Partial<CapRow> = {}) {
      const at = new Date('2026-09-01T00:00:00Z');
      caps.push({
        id: `cap-${caps.length + 1}`,
        tenantId: 'tenant-1',
        grantId,
        label: 'Sara',
        amount: D(amount),
        currencyCode: 'USD',
        period: SpendingCapPeriod.none,
        startsAt: at,
        periodStartsAt: at,
        spent: D(0),
        ...over,
      });
    },
  };
}

const ledgerService = new WalletLedgerService();
const holdService = new WalletHoldService(ledgerService);
const reserve = new VpnReserve(holdService, GIB);
const capped = new SpendingCaps();
const blocks = new BlockPurchaseService(null as never, ledgerService, reserve);

beforeEach(() => {
  installVpnReserve(reserve);
  installSpendingCaps(capped);
});
afterEach(() => {
  installVpnReserve(NO_VPN_RESERVE);
  installSpendingCaps(NO_SPENDING_CAPS);
});

describe('periodStart — a monthly cap restarts on its own start date', () => {
  const anchor = new Date('2026-01-31T10:00:00Z');

  it('clamps the day to a shorter month, and keeps the time of day', () => {
    expect(periodStart(anchor, new Date('2026-02-28T11:00:00Z')).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(periodStart(anchor, new Date('2026-03-31T10:00:00Z')).toISOString()).toBe('2026-03-31T10:00:00.000Z');
  });

  it('is the previous anniversary until the next one is reached', () => {
    expect(periodStart(anchor, new Date('2026-02-28T09:59:59Z')).toISOString()).toBe('2026-01-31T10:00:00.000Z');
    expect(periodStart(anchor, anchor).toISOString()).toBe('2026-01-31T10:00:00.000Z');
  });
});

describe('a capped Grant is funded to min(wallet, cap − spent)', () => {
  it('sizes a block to what the cap leaves, counts it as spent, and cuts the Grant at the cap', async () => {
    const s = fakeStore();
    s.fund('100.00');
    s.grant('g1');
    s.cap('g1', '15.00');

    // The reserve is money promised to this Grant: it counts against the cap.
    await reserve.top(s.tx, 'g1');
    expect(s.openHold('g1')).toBe('10.00');

    // 2 GiB would cost 20.00; the wallet has it, the cap leaves 15.00.
    const bought = await blocks.purchase(s.tx, { grantId: 'g1', targetBytes: BigInt(2) * GIB });
    expect(bought.amount.toFixed(2)).toBe('15.00');
    expect(s.caps[0].spent.toFixed(2)).toBe('15.00');
    // Nothing left under the cap: no reserve, whatever the wallet holds.
    expect(s.openHold('g1')).toBeNull();
    expect(s.wallet.cachedBalance.toFixed(2)).toBe('85.00');

    await expect(blocks.purchase(s.tx, { grantId: 'g1', targetBytes: GIB })).rejects.toMatchObject({ reason: 'cap_reached' });
    await expect(blocks.purchase(s.tx, { grantId: 'g1', targetBytes: GIB })).rejects.toBeInstanceOf(BlockPurchaseRefused);
    expect(s.wallet.cachedBalance.toFixed(2)).toBe('85.00');
  });

  it("leaves the owner's other products the rest of the wallet", async () => {
    const s = fakeStore();
    s.fund('100.00');
    s.grant('g1');
    s.grant('g2');
    s.cap('g1', '3.00');

    expect((await reserve.top(s.tx, 'g1')).toFixed(2)).toBe('3.00');
    expect((await reserve.top(s.tx, 'g2')).toFixed(2)).toBe('10.00');
    const bought = await blocks.purchase(s.tx, { grantId: 'g2', targetBytes: BigInt(5) * GIB });
    expect(bought.amount.toFixed(2)).toBe('50.00');
  });

  it('counts every hold of the Grant — its meters too — against the cap', async () => {
    const s = fakeStore();
    s.fund('100.00');
    s.grant('g1');
    s.meters.push({ id: 'meter-1', grantId: 'g1' });
    s.cap('g1', '12.00', { spent: D('2.00') });
    await holdService.hold(s.tx, { userId: 'user-1', ownerRef: 'meter-1', amount: D('5.00'), currencyCode: 'USD' });

    // 12 − 2 spent − 5 held elsewhere = 5 for anything new; the meter's own 5 is its own.
    expect((await capped.within(s.tx, { id: 'g1', userId: 'user-1' }, D('95.00'))).toFixed(2)).toBe('5.00');
    expect((await capped.within(s.tx, { id: 'g1', userId: 'user-1' }, D('100.00'), D('5.00'))).toFixed(2)).toBe('10.00');
    // A Grant with no cap is bounded by the wallet alone.
    s.grant('g2');
    expect((await capped.within(s.tx, { id: 'g2', userId: 'user-1' }, D('95.00'))).toFixed(2)).toBe('95.00');
  });

  it('starts a monthly cap over on its own date, and a `none` cap never', async () => {
    const s = fakeStore();
    s.fund('100.00');
    s.grant('g1');
    s.grant('g2');
    const start = new Date('2026-01-31T10:00:00Z');
    s.cap('g1', '15.00', { period: SpendingCapPeriod.monthly, startsAt: start, periodStartsAt: start, spent: D('15.00') });
    s.cap('g2', '15.00', { startsAt: start, periodStartsAt: start, spent: D('15.00') });
    const g1 = { id: 'g1', userId: 'user-1' };

    expect((await capped.within(s.tx, g1, D('100.00'), D(0), new Date('2026-02-28T09:00:00Z'))).toFixed(2)).toBe('0.00');
    expect((await capped.within(s.tx, g1, D('100.00'), D(0), new Date('2026-02-28T10:00:00Z'))).toFixed(2)).toBe('15.00');
    expect(s.caps[0].spent.toFixed(2)).toBe('0.00');
    expect(s.caps[0].periodStartsAt.toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect((await capped.within(s.tx, { id: 'g2', userId: 'user-1' }, D('100.00'), D(0), new Date('2026-06-01T00:00:00Z'))).toFixed(2)).toBe('0.00');
  });
});

describe('the owner sets, raises and removes a cap', () => {
  const service = new SpendingCapService(null as never);
  const at = new Date('2026-09-29T12:00:00Z');

  it("is the owner's alone: another user's Grant is the same refusal as a missing one", async () => {
    const s = fakeStore();
    s.grant('g1', { userId: 'user-2' });
    await expect(service.setIn(s.tx, 'user-1', 'g1', { label: 'Sara', amount: '5', period: 'none' }, at)).rejects.toMatchObject({ reason: 'grant_not_found' });
    await expect(service.setIn(s.tx, 'user-1', 'nope', { label: 'Sara', amount: '5', period: 'none' }, at)).rejects.toBeInstanceOf(SpendingCapRefused);
  });

  it("is written in the wallet's currency, counting from when it is set, and reads back spent and left", async () => {
    const s = fakeStore();
    s.fund('40.00');
    s.grant('g1');
    const view = await service.setIn(s.tx, 'user-1', 'g1', { label: 'Sara', amount: '25.5', period: 'monthly' }, at);
    expect(view).toMatchObject({ grantId: 'g1', label: 'Sara', amount: '25.50', currencyCode: 'USD', period: 'monthly', spent: '0.00' });
    // Setting it tops the reserve inside it at once.
    expect(s.openHold('g1')).toBe('10.00');
    expect(view.held).toBe('10.00');
    expect(view.left).toBe('25.50');
  });

  it('lowered, it gives back the reserve past it at once', async () => {
    const s = fakeStore();
    s.fund('40.00');
    s.grant('g1');
    await reserve.top(s.tx, 'g1');
    await service.setIn(s.tx, 'user-1', 'g1', { label: 'Sara', amount: '4', period: 'none' }, at);
    expect(s.openHold('g1')).toBe('4.00');
  });

  it('raised or removed, it brings back the Grant it cut — and a Grant still at its cap stays cut', async () => {
    const s = fakeStore();
    s.fund('50.00');
    s.grant('g1', { status: GrantStatus.suspended, statusReason: CAP_REACHED, suspendedAt: at });
    s.cap('g1', '10.00', { spent: D('10.00') });

    await service.setIn(s.tx, 'user-1', 'g1', { label: 'Sara', amount: '10', period: 'none' }, at);
    expect(s.caps[0].spent.toFixed(2)).toBe('10.00'); // same period: the count stands
    await expect(s.tx.grant.findUnique({ where: { id: 'g1' } })).resolves.toMatchObject({ status: GrantStatus.suspended });

    await service.setIn(s.tx, 'user-1', 'g1', { label: 'Sara', amount: '20', period: 'none' }, at);
    await expect(s.tx.grant.findUnique({ where: { id: 'g1' } })).resolves.toMatchObject({ status: GrantStatus.active });
    expect(s.openHold('g1')).toBe('10.00');

    await service.removeIn(s.tx, 'user-1', 'g1');
    expect(s.caps).toHaveLength(0);
    expect(s.openHold('g1')).toBe('10.00');
  });
});

describe('a Grant cut by its cap says so (F-118-t)', () => {
  const at = new Date('2026-09-20T00:00:00Z');
  const spentBag = { purchasedBytes: GIB, billed: GIB };
  const kinds = (s: ReturnType<typeof fakeStore>) => s.events.map((e) => e.type);

  it('is suspended `cap_reached` and told "raise the cap" when the wallet could buy what the cap refuses', async () => {
    const s = fakeStore();
    s.fund('100.00');
    s.grant('g1', { ...spentBag, consumedBytes: GIB });
    s.cap('g1', '10.00', { spent: D('10.00') });

    await expect(suspendIfExhausted(s.tx, 'g1', at)).resolves.toMatchObject({ verdict: 'suspended' });
    await expect(s.tx.grant.findUnique({ where: { id: 'g1' } })).resolves.toMatchObject({ status: GrantStatus.suspended, statusReason: CAP_REACHED });
    expect(kinds(s)).toEqual([OutboxEventType.GRANT_CAP_REACHED]);
  });

  it('is `quota_exhausted` / `wallet_spent` when the wallet itself is short, capped or not — the top-up comes first', async () => {
    const s = fakeStore();
    s.grant('g1', { ...spentBag, consumedBytes: GIB });
    s.cap('g1', '10.00', { spent: D('10.00') });

    await suspendIfExhausted(s.tx, 'g1', at);
    await expect(s.tx.grant.findUnique({ where: { id: 'g1' } })).resolves.toMatchObject({ statusReason: QUOTA_EXHAUSTED });
    expect(kinds(s)).toEqual([OutboxEventType.GRANT_WALLET_SPENT]);
  });

  it('stays cut through a top-up, and a raised cap brings it back and says so', async () => {
    const s = fakeStore();
    s.fund('100.00');
    s.grant('g1', { ...spentBag, status: GrantStatus.suspended, statusReason: CAP_REACHED, suspendedAt: at });
    s.cap('g1', '10.00', { spent: D('10.00') });

    await reviveFundedGrants(s.tx, 'user-1', D('150.00'), at);
    await expect(s.tx.grant.findUnique({ where: { id: 'g1' } })).resolves.toMatchObject({ status: GrantStatus.suspended, statusReason: CAP_REACHED });
    expect(kinds(s)).toEqual([]);

    await new SpendingCapService(null as never).setIn(s.tx, 'user-1', 'g1', { label: 'Sara', amount: '30', period: 'none' }, at);
    await expect(s.tx.grant.findUnique({ where: { id: 'g1' } })).resolves.toMatchObject({ status: GrantStatus.active, statusReason: null });
    expect(kinds(s)).toEqual([OutboxEventType.GRANT_REACTIVATED]);
  });
});
