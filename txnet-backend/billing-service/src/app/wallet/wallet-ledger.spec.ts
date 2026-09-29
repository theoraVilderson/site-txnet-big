import { Prisma } from '@prisma/client';

import {
  InsufficientFunds,
  InvalidLedgerAmount,
  WalletLedgerService,
  WalletVersionConflict,
} from './wallet-ledger.service';

/**
 * The wallet credit/debit primitive (F-092-b).
 *
 * The invariant this file holds is billing invariant 4: `cachedBalance` is
 * written under its `version`, so of two debits that read the same balance
 * exactly one lands — the other is refused and appends nothing. Without it both
 * subtract from the same starting balance and the wallet pays out twice what it
 * held, with a ledger that looks perfectly consistent row by row.
 *
 * The fake is a store, not a list of expected calls: `updateMany` applies its
 * `where` the way Postgres re-checks it after waiting on a row lock, which is
 * the only property the version guard relies on.
 */
const D = (v: string | number) => new Prisma.Decimal(v);

type WalletRow = {
  id: string;
  ownerUserId: string;
  currencyCode: string;
  cachedBalance: Prisma.Decimal;
  heldAmount: Prisma.Decimal;
  version: number;
};

function fakeStore() {
  const wallets = new Map<string, WalletRow>();
  const ledger: Array<Record<string, unknown>> = [];
  const outbox: Array<Record<string, unknown>> = [];
  /** Resolved when every expected reader has read — forces the interleaving. */
  let barrier: { waiting: number; release: () => void; ready: Promise<void> } | null = null;

  const tx = {
    wallet: {
      findUnique: async ({ where }: { where: { ownerUserId: string } }) => {
        const row = wallets.get(where.ownerUserId);
        const snapshot = row ? { ...row } : null;
        if (barrier) {
          barrier.waiting -= 1;
          if (barrier.waiting === 0) barrier.release();
          await barrier.ready;
        }
        return snapshot;
      },
      findUniqueOrThrow: async (args: { where: { ownerUserId: string } }) => {
        const row = await tx.wallet.findUnique(args);
        if (!row) throw new Error('no wallet');
        return row;
      },
      createMany: async ({ data }: { data: Array<{ ownerUserId: string; currencyCode: string }> }) => {
        let count = 0;
        for (const { ownerUserId, currencyCode } of data) {
          if (wallets.has(ownerUserId)) continue;
          wallets.set(ownerUserId, {
            id: `wallet-${ownerUserId}`,
            currencyCode,
            ownerUserId,
            cachedBalance: D(0),
            heldAmount: D(0),
            version: 0,
          });
          count += 1;
        }
        return { count };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; version: number };
        data: { cachedBalance: Prisma.Decimal; version: { increment: number } };
      }) => {
        const row = [...wallets.values()].find(
          (w) => w.id === where.id && w.version === where.version,
        );
        if (!row) return { count: 0 };
        row.cachedBalance = data.cachedBalance;
        row.version += data.version.increment;
        return { count: 1 };
      },
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
      });
    },
    /** The next `readers` wallet reads each wait until all of them have read. */
    interleave(readers: number) {
      let release!: () => void;
      const ready = new Promise<void>((r) => (release = r));
      barrier = { waiting: readers, release, ready };
    },
  };
}

describe('WalletLedgerService', () => {
  const ledgerService = new WalletLedgerService();

  it('lets exactly one of two debits that read the same version land', async () => {
    const store = fakeStore();
    store.seed('user-1', '100.00');
    store.interleave(2);

    const debit = (referenceId: string) =>
      ledgerService.debit(store.tx, {
        userId: 'user-1',
        amount: D('70.00'),
        currencyCode: 'USD',
        reasonType: 'traffic_consumption',
        referenceId,
      });
    const results = await Promise.allSettled([debit('ref-a'), debit('ref-b')]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(WalletVersionConflict);

    // The loser appended nothing, and the cache agrees with the one row.
    expect(store.ledger).toHaveLength(1);
    const wallet = store.wallets.get('user-1')!;
    expect(wallet.cachedBalance.toFixed(2)).toBe('30.00');
    expect(wallet.version).toBe(1);
    expect((store.ledger[0]['balanceAfter'] as Prisma.Decimal).toFixed(2)).toBe('30.00');
  });

  it('refuses a debit past the balance and writes nothing', async () => {
    const store = fakeStore();
    store.seed('user-1', '10.00');

    await expect(
      ledgerService.debit(store.tx, {
        userId: 'user-1',
        amount: D('10.01'),
        currencyCode: 'USD',
        reasonType: 'traffic_consumption',
      }),
    ).rejects.toBeInstanceOf(InsufficientFunds);
    expect(store.ledger).toHaveLength(0);
    expect(store.wallets.get('user-1')!.version).toBe(0);
  });

  it('refuses a debit from a user who has no wallet, without creating one', async () => {
    const store = fakeStore();

    await expect(
      ledgerService.debit(store.tx, {
        userId: 'user-1',
        amount: D('1.00'),
        currencyCode: 'USD',
        reasonType: 'traffic_consumption',
      }),
    ).rejects.toBeInstanceOf(InsufficientFunds);
    expect(store.wallets.size).toBe(0);
  });

  it('opens the wallet on a first credit and records a positive amount with its direction', async () => {
    const store = fakeStore();

    const row = await ledgerService.credit(store.tx, {
      userId: 'user-1',
      amount: D('25.50'),
      currencyCode: 'USD',
      reasonType: 'payment_gateway',
      referenceId: 'payment-1',
    });

    expect(row).toMatchObject({
      walletId: 'wallet-user-1',
      direction: 'credit',
      reasonType: 'payment_gateway',
      referenceId: 'payment-1',
    });
    expect((row.amount as Prisma.Decimal).toFixed(2)).toBe('25.50');
    expect((row.balanceAfter as Prisma.Decimal).toFixed(2)).toBe('25.50');
    expect(store.wallets.get('user-1')!.cachedBalance.toFixed(2)).toBe('25.50');
  });

  it.each([
    ['zero', '0'],
    ['negative', '-5.00'],
    ['finer than the column holds', '1.005'],
  ])('refuses a %s amount rather than storing it', async (_label, amount) => {
    const store = fakeStore();
    store.seed('user-1', '100.00');

    await expect(
      ledgerService.credit(store.tx, {
        userId: 'user-1',
        amount: D(amount),
        currencyCode: 'USD',
        reasonType: 'admin_manual_adjust',
      }),
    ).rejects.toBeInstanceOf(InvalidLedgerAmount);
    expect(store.ledger).toHaveLength(0);
  });

  // F-111-m: the owner's open panel hears every movement at once. The event is
  // written in the caller's transaction, so it commits with the balance it
  // announces or not at all (ADR-0021), and every writer — billing's and
  // tenant-service's — announces without doing anything itself.
  it('announces every movement to its owner in the same transaction', async () => {
    const store = fakeStore();
    store.seed('user-1', '100.00');

    await ledgerService.debit(store.tx, { userId: 'user-1', amount: D('30.00'), currencyCode: 'USD', reasonType: 'traffic_consumption', tenantId: 't-1' });
    await ledgerService.credit(store.tx, { userId: 'user-1', amount: D('5.00'), currencyCode: 'USD', reasonType: 'payment_gateway', tenantId: 't-1' });

    expect(store.outbox).toEqual([
      expect.objectContaining({ aggregate: 'billing.wallet', aggregateId: 'wallet-user-1', type: 'billing.wallet.changed', payload: { tenantId: 't-1', userId: 'user-1', walletTransactionId: 'ledger-1' } }),
      expect.objectContaining({ type: 'billing.wallet.changed', payload: { tenantId: 't-1', userId: 'user-1', walletTransactionId: 'ledger-2' } }),
    ]);
  });

  it('announces nothing for a refused movement', async () => {
    const store = fakeStore();
    store.seed('user-1', '10.00');

    await expect(
      ledgerService.debit(store.tx, { userId: 'user-1', amount: D('30.00'), currencyCode: 'USD', reasonType: 'traffic_consumption' }),
    ).rejects.toBeInstanceOf(InsufficientFunds);
    expect(store.outbox).toEqual([]);
  });
});
