import { HELD_PUSH_EVERY_MS } from '@txnet-backend/shared-core';
import { Prisma } from '@prisma/client';

import {
  HoldExceeded,
  InsufficientFunds,
  WalletHoldService,
  WalletLedgerService,
} from './wallet-ledger.service';

/**
 * Wallet holds (F-118-a, ADR-0105 (6), billing invariant 21).
 *
 * The invariant this file holds: **held money is not spendable** — by any
 * debit, whether or not its code knows holds exist — and a capture is the one
 * way it leaves: one ledger debit and the hold reduced by the same amount,
 * under one `version`. Without it, a postpaid meter and a product purchase
 * spend the same balance, and the service the hold promised is served unfunded
 * (the loss ADR-0072 exists to prevent).
 *
 * `CHECK (cachedBalance - heldAmount >= 0)` and the deferred trigger that ties
 * `heldAmount` to the open holds are Postgres's, and proven against it in
 * `wallet-ledger.int.spec.ts`. This file proves the service refuses first,
 * with the error its callers already map, instead of a raw constraint failure.
 */
const D = (v: string | number) => new Prisma.Decimal(v);

type WalletRow = {
  id: string;
  ownerUserId: string;
  currencyCode: string;
  cachedBalance: Prisma.Decimal;
  heldAmount: Prisma.Decimal;
  version: number;
  heldPushedAt: Date | null;
};

type HoldRow = {
  id: string;
  walletId: string;
  ownerRef: string;
  amount: Prisma.Decimal;
  captured: Prisma.Decimal;
  status: 'open' | 'closed';
  currencyCode: string;
  closedAt: Date | null;
};

type Num = Prisma.Decimal | { increment?: Prisma.Decimal; decrement?: Prisma.Decimal };
const apply = (v: Prisma.Decimal, n: Num) =>
  n instanceof Prisma.Decimal ? n : v.plus(n.increment ?? 0).minus(n.decrement ?? 0);

function fakeStore() {
  const wallets = new Map<string, WalletRow>();
  const holds: HoldRow[] = [];
  const ledger: Array<Record<string, unknown>> = [];
  const outbox: Array<Record<string, unknown>> = [];

  const tx = {
    wallet: {
      findUnique: async ({ where }: { where: { ownerUserId: string } }) => {
        const row = wallets.get(where.ownerUserId);
        return row ? { ...row } : null;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; version?: number; OR?: Array<{ heldPushedAt: null | { lt: Date } }> };
        data: { cachedBalance?: Prisma.Decimal; heldAmount?: Prisma.Decimal; version?: { increment: number }; heldPushedAt?: Date };
      }) => {
        const row = [...wallets.values()].find(
          (w) =>
            w.id === where.id &&
            (where.version === undefined || w.version === where.version) &&
            (!where.OR ||
              where.OR.some((c) => (c.heldPushedAt === null ? w.heldPushedAt === null : !!w.heldPushedAt && w.heldPushedAt < c.heldPushedAt.lt))),
        );
        if (!row) return { count: 0 };
        if (data.cachedBalance) row.cachedBalance = data.cachedBalance;
        if (data.heldAmount) row.heldAmount = data.heldAmount;
        if (data.heldPushedAt) row.heldPushedAt = data.heldPushedAt;
        if (data.version) row.version += data.version.increment;
        return { count: 1 };
      },
    },
    user: { findUniqueOrThrow: async () => ({ tenantId: 't-1' }) },
    walletHold: {
      findFirst: async ({ where }: { where: { walletId: string; ownerRef: string; status: 'open' } }) => {
        const row = holds.find(
          (h) => h.walletId === where.walletId && h.ownerRef === where.ownerRef && h.status === where.status,
        );
        return row ? { ...row } : null;
      },
      create: async ({ data }: { data: Omit<HoldRow, 'id' | 'captured' | 'status' | 'closedAt'> }) => {
        const row: HoldRow = { id: `hold-${holds.length + 1}`, captured: D(0), status: 'open', closedAt: null, ...data };
        holds.push(row);
        return { ...row };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: 'open'; amount?: { gte: Prisma.Decimal } };
        data: { amount?: Num; captured?: Num; status?: 'closed'; closedAt?: Date };
      }) => {
        const row = holds.find(
          (h) => h.id === where.id && h.status === where.status && (!where.amount || h.amount.gte(where.amount.gte)),
        );
        if (!row) return { count: 0 };
        if (data.amount) row.amount = apply(row.amount, data.amount);
        if (data.captured) row.captured = apply(row.captured, data.captured);
        if (data.status) row.status = data.status;
        if (data.closedAt) row.closedAt = data.closedAt;
        return { count: 1 };
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({ ...holds.find((h) => h.id === where.id)! }),
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
        outbox.push(data);
        return data;
      },
    },
  };

  return {
    tx: tx as unknown as Prisma.TransactionClient,
    wallets,
    holds,
    ledger,
    outbox,
    seed(ownerUserId: string, balance: string) {
      wallets.set(ownerUserId, {
        id: `wallet-${ownerUserId}`,
        ownerUserId,
        currencyCode: 'USD',
        cachedBalance: D(balance),
        heldAmount: D(0),
        version: 0,
        heldPushedAt: null,
      });
    },
  };
}

describe('WalletHoldService', () => {
  const ledger = new WalletLedgerService();
  const holds = new WalletHoldService(ledger);
  const GRANT = 'grant-1';
  const hold = (store: ReturnType<typeof fakeStore>, amount: string, ownerRef = GRANT) =>
    holds.hold(store.tx, { userId: 'user-1', ownerRef, amount: D(amount), currencyCode: 'USD' });

  it('locks held money against every debit, however it was written', async () => {
    const store = fakeStore();
    store.seed('user-1', '100.00');
    await hold(store, '70.00');

    // A product purchase that knows nothing about holds: 30.01 of 100 would
    // fit the balance, but only 30.00 is not promised elsewhere.
    await expect(
      ledger.debit(store.tx, { userId: 'user-1', amount: D('30.01'), currencyCode: 'USD', reasonType: 'product_purchase' }),
    ).rejects.toBeInstanceOf(InsufficientFunds);
    expect(store.ledger).toHaveLength(0);

    await ledger.debit(store.tx, { userId: 'user-1', amount: D('30.00'), currencyCode: 'USD', reasonType: 'product_purchase' });
    const wallet = store.wallets.get('user-1')!;
    expect(wallet.cachedBalance.toFixed(2)).toBe('70.00');
    expect(wallet.heldAmount.toFixed(2)).toBe('70.00');
  });

  it('refuses a hold past what is not already held, and writes nothing', async () => {
    const store = fakeStore();
    store.seed('user-1', '100.00');
    await hold(store, '60.00', 'grant-a');

    await expect(hold(store, '40.01', 'grant-b')).rejects.toBeInstanceOf(InsufficientFunds);
    expect(store.holds).toHaveLength(1);
    expect(store.wallets.get('user-1')!.heldAmount.toFixed(2)).toBe('60.00');
  });

  it('tops up the one open hold an owner has, under the wallet version', async () => {
    const store = fakeStore();
    store.seed('user-1', '100.00');
    await hold(store, '20.00');
    const row = await hold(store, '15.00');

    expect(store.holds).toHaveLength(1);
    expect(row.amount.toFixed(2)).toBe('35.00');
    const wallet = store.wallets.get('user-1')!;
    expect(wallet.heldAmount.toFixed(2)).toBe('35.00');
    expect(wallet.version).toBe(2);
  });

  it('captures as one ledger debit with the hold reduced by the same amount', async () => {
    const store = fakeStore();
    store.seed('user-1', '100.00');
    await hold(store, '50.00');

    const movement = await holds.capture(store.tx, {
      userId: 'user-1',
      ownerRef: GRANT,
      amount: D('12.34'),
      currencyCode: 'USD',
      reasonType: 'traffic_consumption',
      referenceId: GRANT,
    });

    expect(store.ledger).toHaveLength(1);
    expect(movement['direction']).toBe('debit');
    expect((movement['balanceAfter'] as Prisma.Decimal).toFixed(2)).toBe('87.66');
    const wallet = store.wallets.get('user-1')!;
    expect(wallet.cachedBalance.toFixed(2)).toBe('87.66');
    expect(wallet.heldAmount.toFixed(2)).toBe('37.66');
    // What was free before the capture is exactly what is free after it.
    expect(wallet.cachedBalance.minus(wallet.heldAmount).toFixed(2)).toBe('50.00');
    expect(store.holds[0].amount.toFixed(2)).toBe('37.66');
    expect(store.holds[0].captured.toFixed(2)).toBe('12.34');
  });

  it('refuses a capture larger than the hold, and writes nothing', async () => {
    const store = fakeStore();
    store.seed('user-1', '100.00');
    await hold(store, '10.00');

    await expect(
      holds.capture(store.tx, {
        userId: 'user-1',
        ownerRef: GRANT,
        amount: D('10.01'),
        currencyCode: 'USD',
        reasonType: 'traffic_consumption',
      }),
    ).rejects.toBeInstanceOf(HoldExceeded);
    expect(store.ledger).toHaveLength(0);
    expect(store.holds[0].amount.toFixed(2)).toBe('10.00');
    expect(store.wallets.get('user-1')!.heldAmount.toFixed(2)).toBe('10.00');
  });

  it('releases part of a hold, then closes it with the rest, moving no money', async () => {
    const store = fakeStore();
    store.seed('user-1', '100.00');
    await hold(store, '40.00');

    await holds.release(store.tx, { userId: 'user-1', ownerRef: GRANT, amount: D('15.00') });
    expect(store.wallets.get('user-1')!.heldAmount.toFixed(2)).toBe('25.00');
    expect(store.holds[0].status).toBe('open');

    const closed = await holds.release(store.tx, { userId: 'user-1', ownerRef: GRANT });
    expect(closed.status).toBe('closed');
    expect(closed.amount.toFixed(2)).toBe('0.00');
    const wallet = store.wallets.get('user-1')!;
    expect(wallet.heldAmount.toFixed(2)).toBe('0.00');
    expect(wallet.cachedBalance.toFixed(2)).toBe('100.00');
    expect(store.ledger).toHaveLength(0);

    // A closed hold is history: the next one for the same owner is a new row.
    await hold(store, '5.00');
    expect(store.holds).toHaveLength(2);
  });

  /**
   * F-118-o: a hold or a release moves `available`, so the owner's open panel
   * is told — but the VPN reserve is re-topped every minute, so a wallet is
   * announced at most once per {@link HELD_PUSH_EVERY_MS}. The payload names
   * the wallet and no figure: the panel re-reads, so a skipped one loses nothing
   * the next read does not bring.
   */
  describe('telling the panel held money moved', () => {
    const t0 = new Date('2026-09-29T12:00:00Z');
    beforeEach(() => vi.useFakeTimers({ now: t0 }));
    afterEach(() => vi.useRealTimers());
    const held = (store: ReturnType<typeof fakeStore>) => store.outbox.filter((e) => e['type'] === 'billing.wallet.changed');

    it('announces a hold, then no second one inside the window, then the next after it', async () => {
      const store = fakeStore();
      store.seed('user-1', '100.00');

      await hold(store, '10.00');
      expect(held(store)).toEqual([
        { aggregate: 'billing.wallet', aggregateId: 'wallet-user-1', type: 'billing.wallet.changed', payload: { tenantId: 't-1', userId: 'user-1' } },
      ]);

      vi.setSystemTime(t0.getTime() + HELD_PUSH_EVERY_MS - 1);
      await hold(store, '5.00');
      await holds.release(store.tx, { userId: 'user-1', ownerRef: GRANT, amount: D('1.00') });
      expect(held(store)).toHaveLength(1);

      vi.setSystemTime(t0.getTime() + HELD_PUSH_EVERY_MS + 1);
      await holds.release(store.tx, { userId: 'user-1', ownerRef: GRANT });
      expect(held(store)).toHaveLength(2);
    });

    it('coalesces per wallet, not per platform', async () => {
      const store = fakeStore();
      store.seed('user-1', '100.00');
      store.seed('user-2', '100.00');
      await hold(store, '10.00');
      await holds.hold(store.tx, { userId: 'user-2', ownerRef: 'grant-2', amount: D('10.00'), currencyCode: 'USD' });

      expect(held(store).map((e) => e['aggregateId'])).toEqual(['wallet-user-1', 'wallet-user-2']);
    });

    it('announces nothing for a refused hold', async () => {
      const store = fakeStore();
      store.seed('user-1', '10.00');
      await expect(hold(store, '10.01')).rejects.toBeInstanceOf(InsufficientFunds);
      expect(store.outbox).toHaveLength(0);
      expect(store.wallets.get('user-1')!.heldPushedAt).toBeNull();
    });
  });
});
