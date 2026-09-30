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
  /** Its prepaid `vpn.traffic` meter's `unitPrice`; null = no meter (F-118-l). */
  rate: Prisma.Decimal | null;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  /** The meter's money cursor. */
  billed: bigint;
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
      update: async ({ where, data }: { where: { id: string }; data: { purchasedBytes: { increment: bigint } } }) => {
        const g = grants.get(where.id)!;
        g.purchasedBytes += data.purchasedBytes.increment;
        return { ...g };
      },
      updateMany: async ({ where, data }: { where: { id: string; status: GrantStatus; statusReason?: string }; data: { status: GrantStatus } }) => {
        const g = grants.get(where.id);
        if (!g || g.status !== where.status || (where.statusReason !== undefined && g.statusReason !== where.statusReason)) return { count: 0 };
        g.status = data.status;
        return { count: 1 };
      },
      // The share's read (F-118-ag): the owner's leased metered Grants.
      findMany: async ({ where }: { where: { userId: string; status: { in: GrantStatus[] }; billingMode: VariantBillingMode; trafficUnlimited: boolean } }) =>
        [...grants.values()]
          .filter((g) => g.userId === where.userId && where.status.in.includes(g.status) && g.billingMode === where.billingMode && g.rate && g.trafficUnlimited === where.trafficUnlimited)
          .map((g) => ({ id: g.id })),
    },
    config: { updateMany: async () => ({ count: 1 }) },
    // A metered Grant's prepaid vpn.traffic meter (F-118-l): its rate and money cursor, id = the Grant's.
    grantMeter: {
      findUnique: async ({ where }: { where: { grantId_meterKey: { grantId: string } } }) => {
        const g = grants.get(where.grantId_meterKey.grantId);
        return g?.rate ? { id: g.id, mode: 'prepaid', unitPrice: g.rate, currencyCode: 'USD', billed: g.billed } : null;
      },
      // A prepaid meter's hold is never its own (the reserve's ownerRef is the Grant): no meter ids to add.
      findMany: async () => [],
      update: async ({ where, data }: { where: { id: string }; data: { billed: { increment: bigint } } }) => {
        const g = grants.get(where.id)!;
        g.billed += data.billed.increment;
        return { billed: g.billed };
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
      findMany: async ({ where }: { where: { walletId: string; status: 'open'; ownerRef: { in: string[] } } }) =>
        holds.filter((r) => r.walletId === where.walletId && r.status === where.status && where.ownerRef.in.includes(r.ownerRef)).map((r) => ({ ...r })),
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
        rate: D('10'),
        trafficUnlimited: false,
        purchasedBytes: BigInt(0),
        billed: BigInt(0),
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
    s.fund('25.00');
    s.grant('g1');
    s.grant('g2');
    await reserve.top(s.tx, 'g1');
    await reserve.top(s.tx, 'g2');
    expect(s.openReserve('g1')).toBe('10.00');
    expect(s.openReserve('g2')).toBe('10.00');
    expect(s.wallet.heldAmount.toFixed(2)).toBe('20.00');
  });

  it('holds nothing for a Grant the planner leases no reserve to', async () => {
    const s = fakeStore();
    s.fund('50.00');
    s.grant('prepaid', { billingMode: VariantBillingMode.prepaid, rate: null });
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

describe('the fair share (F-118-ag)', () => {
  // A wallet smaller than the Grants' reserves together: the first one topped
  // held all of it and the next held nothing (live run 2026-09-30 — a second
  // service stayed pending, a capped one was cut with 7.83 in the wallet).

  it('splits a wallet smaller than the reserves evenly', async () => {
    const s = fakeStore();
    s.fund('15.00');
    s.grant('g1');
    s.grant('g2');
    await reserve.top(s.tx, 'g1');
    await reserve.top(s.tx, 'g2');
    expect(s.openReserve('g1')).toBe('7.50');
    expect(s.openReserve('g2')).toBe('7.50');
  });

  it('takes a new Grant share back from one that held the whole wallet, spending nothing', async () => {
    const s = fakeStore();
    s.fund('13.00');
    s.grant('g1');
    expect((await reserve.top(s.tx, 'g1')).toFixed(2)).toBe('10.00'); // alone, up to its size
    s.grant('g2', { status: GrantStatus.pending });

    expect((await reserve.top(s.tx, 'g2')).toFixed(2)).toBe('6.50');
    expect(s.openReserve('g1')).toBe('6.50');
    expect(s.wallet.heldAmount.toFixed(2)).toBe('13.00');
    expect(s.wallet.cachedBalance.toFixed(2)).toBe('13.00');
    expect(s.ledger).toHaveLength(0);
  });

  it('leaves a wallet large enough for every reserve as it was', async () => {
    const s = fakeStore();
    s.fund('100.00');
    for (const id of ['g1', 'g2', 'g3']) s.grant(id);
    for (const id of ['g1', 'g2', 'g3']) expect((await reserve.top(s.tx, id)).toFixed(2)).toBe('10.00');
  });

  it('keeps a Grant share when a suspended one is revived, not the whole wallet for the first', async () => {
    installVpnReserve(reserve);
    try {
      const s = fakeStore();
      s.fund('8.00');
      s.grant('g1');
      await reserve.top(s.tx, 'g1'); // 8.00, alone
      s.grant('g2', { status: GrantStatus.suspended, statusReason: QUOTA_EXHAUSTED });

      await expect(reviveOnTopUp(s.tx, 'g2')).resolves.toMatchObject({ revived: true });
      expect(s.openReserve('g2')).toBe('4.00');
      expect(s.openReserve('g1')).toBe('4.00');
    } finally {
      installVpnReserve(NO_VPN_RESERVE);
    }
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
    await reserve.top(s.tx, 'g2'); // its share: 5.00 promised to g2

    // A GiB is 10.00: g1 buys what is free (5.00), never g2's 5.00.
    const bought = await blocks.purchase(s.tx, { grantId: 'g1', targetBytes: GIB });
    expect(bought.amount.toFixed(2)).toBe('5.00');
    // What is left is headroom again, split evenly — and still all there.
    expect(s.wallet.cachedBalance.toFixed(2)).toBe('5.00');
    expect(s.openReserve('g2')).toBe('2.50');
    expect(s.openReserve('g1')).toBe('2.50');
  });

  it('takes its share back before a block, when another Grant holds more than its share', async () => {
    const s = fakeStore();
    s.fund('10.00');
    s.grant('g2');
    await reserve.top(s.tx, 'g2'); // alone: all 10.00
    s.grant('g1');

    // g1's share is 5.00: g2's reserve above it is released, never spent.
    const bought = await blocks.purchase(s.tx, { grantId: 'g1', targetBytes: GIB });
    expect(bought.amount.toFixed(2)).toBe('5.00');
    expect(s.ledger.map((r) => r.amount?.toString())).toEqual(['5']); // g1's block, and nothing else
    expect(s.wallet.cachedBalance.toFixed(2)).toBe('5.00');
    expect(s.openReserve('g2')).toBe('2.50');
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
