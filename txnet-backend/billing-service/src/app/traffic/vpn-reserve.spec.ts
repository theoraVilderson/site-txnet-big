import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { reviveOnRenewal, reviveOnTopUp } from '../entitlement/purge';
import { PERIOD_ENDED, QUOTA_EXHAUSTED } from '../entitlement/suspension';
import { InsufficientFunds, WalletHoldService, WalletLedgerService } from '../wallet/wallet-ledger.service';
import { BlockPurchaseService, GIB } from './block-purchase';
import { NO_VPN_RESERVE, VpnReserve, installVpnReserve, releaseVpnReserve, sizeReserve } from './vpn-reserve';

/**
 * The VPN reserve is held money (F-118-b, ADR-0105 (8), network
 * `contract.reserve.md`).
 *
 * The invariant this file holds: **what the panels were promised past a
 * metered Grant's bag is locked on the wallet**, so a product purchase or
 * another meter cannot spend it — and the Grant's own next block can. Without
 * it the planner leases the whole balance while every other debit spends the
 * same balance, and the bytes served in between are served unfunded.
 */
const D = (v: string | number) => new Prisma.Decimal(v);

type Num = Prisma.Decimal | { increment?: Prisma.Decimal | bigint; decrement?: Prisma.Decimal | bigint };
const apply = (v: Prisma.Decimal, n: Num) =>
  n instanceof Prisma.Decimal ? n : v.plus((n.increment ?? 0).toString()).minus((n.decrement ?? 0).toString());

type GrantRow = {
  id: string;
  userId: string;
  status: GrantStatus;
  billingMode: VariantBillingMode;
  meteredRate: Prisma.Decimal | null;
  meteredRateCurrencyCode: string | null;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  billedBytes: bigint;
  statusReason?: string | null;
};

function fakeStore() {
  const grants = new Map<string, GrantRow>();
  const wallet = { id: 'wallet-1', ownerUserId: 'user-1', currencyCode: 'USD', cachedBalance: D(0), heldAmount: D(0), version: 0 };
  const holds: Array<{ id: string; walletId: string; ownerRef: string; amount: Prisma.Decimal; captured: Prisma.Decimal; status: 'open' | 'closed'; currencyCode: string }> = [];
  const ledger: Array<Record<string, unknown>> = [];

  const tx = {
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const g = grants.get(where.id);
        return g ? { ...g } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: { purchasedBytes: { increment: bigint }; billedBytes: { increment: bigint } } }) => {
        const g = grants.get(where.id)!;
        g.purchasedBytes += data.purchasedBytes.increment;
        g.billedBytes += data.billedBytes.increment;
        return { ...g };
      },
      updateMany: async ({ where, data }: { where: { id: string; status: GrantStatus; statusReason?: string }; data: { status: GrantStatus } }) => {
        const g = grants.get(where.id);
        if (!g || g.status !== where.status || (where.statusReason !== undefined && g.statusReason !== where.statusReason)) return { count: 0 };
        g.status = data.status;
        return { count: 1 };
      },
    },
    config: { updateMany: async () => ({ count: 1 }) },
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
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    wallet,
    holds,
    ledger,
    openReserve: (grantId: string) => holds.find((h) => h.ownerRef === grantId && h.status === 'open')?.amount.toFixed(2) ?? null,
    fund(balance: string) {
      wallet.cachedBalance = D(balance);
    },
    grant(id: string, over: Partial<GrantRow> = {}) {
      grants.set(id, {
        id,
        userId: 'user-1',
        status: GrantStatus.active,
        billingMode: VariantBillingMode.metered,
        // 10.00 a GiB: the default reserve of one GiB is 10.00.
        meteredRate: D('10'),
        meteredRateCurrencyCode: 'USD',
        trafficUnlimited: false,
        purchasedBytes: BigInt(0),
        billedBytes: BigInt(0),
        ...over,
      });
    },
  };
}

const ledgerService = new WalletLedgerService();
const holds = new WalletHoldService(ledgerService);
const reserve = new VpnReserve(holds, GIB);

describe('sizeReserve', () => {
  it('prices the reserve at the Grant rate, up to a whole cent', () => {
    // 1 byte at 10.00 a GiB is far under a cent: one cent, never nothing.
    expect(sizeReserve({ rate: D('10'), reserveBytes: BigInt(1), available: D('50') }).toFixed(2)).toBe('0.01');
    expect(sizeReserve({ rate: D('10'), reserveBytes: GIB, available: D('50') }).toFixed(2)).toBe('10.00');
    expect(sizeReserve({ rate: D('0.33333333'), reserveBytes: GIB, available: D('50') }).toFixed(2)).toBe('0.34');
  });

  it('holds less, not nothing, on a short balance — and whole cents of it', () => {
    expect(sizeReserve({ rate: D('10'), reserveBytes: GIB, available: D('3.759') }).toFixed(2)).toBe('3.75');
    expect(sizeReserve({ rate: D('10'), reserveBytes: GIB, available: D('0.009') }).toFixed(2)).toBe('0.00');
  });

  it('holds nothing where no arithmetic prices a byte, or no reserve is set', () => {
    expect(sizeReserve({ rate: D('0'), reserveBytes: GIB, available: D('50') }).toFixed(2)).toBe('0.00');
    expect(sizeReserve({ rate: D('0.000000001'), reserveBytes: GIB, available: D('50') }).toFixed(2)).toBe('0.00');
    expect(sizeReserve({ rate: D('10'), reserveBytes: BigInt(0), available: D('50') }).toFixed(2)).toBe('0.00');
  });
});

describe('VpnReserve', () => {
  it('locks the reserve so a purchase that knows nothing of it cannot spend it', async () => {
    const s = fakeStore();
    s.fund('25.00');
    s.grant('g1');

    expect((await reserve.top(s.tx, 'g1')).toFixed(2)).toBe('10.00');
    expect(s.wallet.heldAmount.toFixed(2)).toBe('10.00');

    // A product of 15.01 fits the balance, but 10.00 of it is the panels'.
    await expect(
      ledgerService.debit(s.tx, { userId: 'user-1', amount: D('15.01'), currencyCode: 'USD', reasonType: 'product_purchase' as never }),
    ).rejects.toBeInstanceOf(InsufficientFunds);
    await ledgerService.debit(s.tx, { userId: 'user-1', amount: D('15.00'), currencyCode: 'USD', reasonType: 'product_purchase' as never });
    expect(s.openReserve('g1')).toBe('10.00');
  });

  it('tops the one open hold up to its target, and a second top moves nothing', async () => {
    const s = fakeStore();
    s.fund('4.00');
    s.grant('g1');
    expect((await reserve.top(s.tx, 'g1')).toFixed(2)).toBe('4.00');

    s.fund('30.00'); // a deposit
    expect((await reserve.top(s.tx, 'g1')).toFixed(2)).toBe('10.00');
    expect((await reserve.top(s.tx, 'g1')).toFixed(2)).toBe('10.00');
    expect(s.holds.filter((h) => h.status === 'open')).toHaveLength(1);
    expect(s.wallet.heldAmount.toFixed(2)).toBe('10.00');
    expect(s.ledger).toHaveLength(0); // a hold is not a ledger row
  });

  it('gives each metered Grant its own reserve, so two never promise the same money', async () => {
    const s = fakeStore();
    s.fund('15.00');
    s.grant('g1');
    s.grant('g2');
    await reserve.top(s.tx, 'g1');
    await reserve.top(s.tx, 'g2');
    expect(s.openReserve('g1')).toBe('10.00');
    expect(s.openReserve('g2')).toBe('5.00');
    expect(s.wallet.heldAmount.toFixed(2)).toBe('15.00');
  });

  it('holds nothing for a Grant the planner leases no reserve to', async () => {
    const s = fakeStore();
    s.fund('50.00');
    s.grant('prepaid', { billingMode: VariantBillingMode.prepaid, meteredRate: null, meteredRateCurrencyCode: null });
    s.grant('unlimited', { trafficUnlimited: true });
    s.grant('suspended', { status: GrantStatus.suspended });
    for (const id of ['prepaid', 'unlimited', 'suspended', 'missing']) {
      expect((await reserve.top(s.tx, id)).toFixed(2)).toBe('0.00');
    }
    expect(s.holds).toHaveLength(0);
  });

  it('is released whole when the Grant stops being served, and a second release moves nothing', async () => {
    const s = fakeStore();
    s.fund('20.00');
    s.grant('g1');
    await reserve.top(s.tx, 'g1');

    expect((await releaseVpnReserve(s.tx, { id: 'g1', userId: 'user-1' })).toFixed(2)).toBe('10.00');
    expect(s.openReserve('g1')).toBeNull();
    expect(s.wallet.heldAmount.toFixed(2)).toBe('0.00');
    expect((await releaseVpnReserve(s.tx, { id: 'g1', userId: 'user-1' })).toFixed(2)).toBe('0.00');
  });
});

describe('BlockPurchaseService with the reserve', () => {
  const blocks = new BlockPurchaseService({} as never, ledgerService, reserve);

  it('pays the Grant own block from its reserve when the free balance is short, then holds the reserve again', async () => {
    const s = fakeStore();
    s.fund('12.00');
    s.grant('g1');
    await reserve.top(s.tx, 'g1'); // 10.00 held, 2.00 free

    // Half a GiB is 5.00: more than is free, less than free plus the reserve.
    const bought = await blocks.purchase(s.tx, { grantId: 'g1', targetBytes: GIB / BigInt(2) });

    expect(bought.amount.toFixed(2)).toBe('5.00');
    expect(s.wallet.cachedBalance.toFixed(2)).toBe('7.00');
    // Topped back from what is left: all of it, since 7.00 is under the target.
    expect(s.openReserve('g1')).toBe('7.00');
    expect(s.wallet.heldAmount.toFixed(2)).toBe('7.00');
  });

  it('never pays one Grant block from another Grant reserve', async () => {
    const s = fakeStore();
    s.fund('10.00');
    s.grant('g1');
    s.grant('g2');
    await reserve.top(s.tx, 'g2'); // all 10.00 promised to g2

    await expect(blocks.purchase(s.tx, { grantId: 'g1', targetBytes: GIB })).rejects.toMatchObject({ reason: 'insufficient_funds' });
    expect(s.openReserve('g2')).toBe('10.00');
    expect(s.ledger).toHaveLength(0);
  });
});

describe('a Grant back to active', () => {
  // Every way back — a top-up, a renewal, an unfreeze, a bulk job — goes
  // through the revive in entitlement/purge.ts or unfreezeGrant, which top
  // the reserve the WalletModule installed: no path waits for the sweep.
  beforeEach(() => installVpnReserve(reserve));
  afterEach(() => installVpnReserve(NO_VPN_RESERVE));

  it.each([
    ['a top-up', QUOTA_EXHAUSTED, reviveOnTopUp],
    ['a renewal', PERIOD_ENDED, reviveOnRenewal],
  ])('holds its reserve in the transaction that revives it: %s', async (_, reason, revive) => {
    const s = fakeStore();
    s.fund('30.00');
    s.grant('g1', { status: GrantStatus.suspended, statusReason: reason });

    await expect(revive(s.tx, 'g1')).resolves.toMatchObject({ revived: true });
    expect(s.openReserve('g1')).toBe('10.00');
  });

  it('holds nothing when nothing was revived', async () => {
    const s = fakeStore();
    s.fund('30.00');
    s.grant('g1', { status: GrantStatus.suspended, statusReason: 'admin_frozen' });

    await expect(reviveOnTopUp(s.tx, 'g1')).resolves.toMatchObject({ revived: false });
    expect(s.holds).toHaveLength(0);
  });
});
