/**
 * The block purchaser (F-027-q; ADR-0072, ADR-0073).
 *
 * What breaks without anyone seeing it:
 *  - **a byte served that nobody paid for.** `purchasedBytes` advances only in
 *    the transaction that debited the wallet for it, so the number the lease
 *    planner (F-027-db) is bounded by can never run ahead of the money;
 *  - **a sub-cent amount reaching the ledger.** The block is sized from its
 *    price — the smallest whole number of cents covering the target — and
 *    `WalletLedgerService` refuses anything finer (`C-02`, ADR-0002);
 *  - **selling more than was bought.** Bytes come back from the amount by
 *    integer division rounding *down*, so the block is always at most what the
 *    debited cents buy at the Grant's own rate;
 *  - **yesterday's traffic repriced.** Every block is priced from
 *    `grant.meteredRate`, locked at issue (F-027-p); nothing here reads the
 *    catalog;
 *  - **a stall with money still in the wallet.** A balance short of the target
 *    buys the largest whole-cent block it can fund, and only a balance under
 *    one cent is refused.
 */
import { GrantStatus, LedgerDirection, Prisma, VariantBillingMode, WalletReasonType } from '@prisma/client';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { BlockPurchaseRefused, BlockPurchaseService, GIB, sizeBlock } from './block-purchase';

const D = (v: string | number) => new Prisma.Decimal(v);
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '77777777-7777-4777-8777-777777777777';

describe('sizeBlock', () => {
  /** $0.40 per GiB — the rate ADR-0073's worked example uses. */
  const rate = D('0.40000000');
  const plenty = D('1000.00');

  it('prices the target first and rounds the price up to a whole cent', () => {
    // 100 MiB at $0.40/GiB is $0.0390625 — 4c, never 3c and never $0.0390625.
    const block = sizeBlock({ rate, targetBytes: BigInt(100) * BigInt(1024 * 1024), maxSpend: plenty });
    expect(block.amount.toFixed(2)).toBe('0.04');
    expect(block.amount.decimalPlaces()).toBeLessThanOrEqual(2);
  });

  it('never sells more bytes than the debited amount buys', () => {
    const block = sizeBlock({ rate, targetBytes: BigInt(100) * BigInt(1024 * 1024), maxSpend: plenty });
    // 4c buys 0.04 / 0.40 GiB = 0.1 GiB exactly; the floor is what is sold.
    const paidFor = block.amount.div(rate).mul(GIB.toString());
    expect(block.bytes.toString()).toBe(paidFor.floor().toFixed(0));
    expect(D(block.bytes.toString()).lte(paidFor)).toBe(true);
  });

  it('covers the target it was asked for, because the price rounded up', () => {
    const targetBytes = BigInt(37) * BigInt(1024 * 1024) + BigInt(11);
    const block = sizeBlock({ rate, targetBytes, maxSpend: plenty });
    expect(block.bytes >= targetBytes).toBe(true);
  });

  it('clamps to what the wallet holds, down to the whole cent below it', () => {
    // A 1 GiB target costs 40c; the wallet holds 13.7c, so 13c is the block.
    const block = sizeBlock({ rate, targetBytes: GIB, maxSpend: D('0.137') });
    expect(block.amount.toFixed(2)).toBe('0.13');
    expect(block.bytes.toString()).toBe('348966092'); // floor(0.13 / 0.40 * 2^30)
  });

  it('refuses a balance under one cent rather than writing a sub-cent row', () => {
    const under = () => sizeBlock({ rate, targetBytes: GIB, maxSpend: D('0.009') });
    expect(under).toThrow(BlockPurchaseRefused);
    expect(under).toThrow(expect.objectContaining({ reason: 'insufficient_funds' }));
  });

  it('refuses a rate that cannot price a byte', () => {
    const priceable = expect.objectContaining({ reason: 'rate_not_priceable' });
    expect(() => sizeBlock({ rate: D('0'), targetBytes: GIB, maxSpend: plenty })).toThrow(priceable);
    // Finer than `Decimal(18, 8)` cannot have come from the column.
    expect(() => sizeBlock({ rate: D('0.000000001'), targetBytes: GIB, maxSpend: plenty })).toThrow(priceable);
  });

  it('refuses a clamped block that buys no whole byte, rather than selling zero', () => {
    // An absurd rate with a one-cent balance: the clamp cuts the block below a
    // single byte. A zero-byte block is a debit for nothing.
    expect(() => sizeBlock({ rate: D('99999999.99999999'), targetBytes: GIB, maxSpend: D('0.01') })).toThrow(
      expect.objectContaining({ reason: 'block_below_one_byte' }),
    );
  });
});

type GrantRow = {
  id: string;
  userId: string;
  status: GrantStatus;
  billingMode: VariantBillingMode;
  meteredRate: Prisma.Decimal | null;
  billedBytes: bigint;
  purchasedBytes: bigint;
};

/**
 * A store, not a list of expected calls — the same shape
 * `wallet-ledger.spec.ts` uses, so the real `WalletLedgerService` runs here and
 * the debit is the one production takes.
 */
function fakeTx(grant: Partial<GrantRow> & { id: string }, balance: Prisma.Decimal) {
  const row: GrantRow = {
    userId: USER,
    status: GrantStatus.active,
    billingMode: VariantBillingMode.metered,
    meteredRate: D('0.40000000'),
    billedBytes: BigInt(0),
    purchasedBytes: BigInt(0),
    ...grant,
  };
  const wallet = { id: 'wallet-1', ownerUserId: USER, currencyCode: 'USD', cachedBalance: balance, version: 0 };
  const ledger: Array<Record<string, unknown>> = [];

  const tx = {
    // Every tenant here keeps its books in USD (F-116-b).
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }), findFirst: async () => ({ operatingCurrencyCode: 'USD' }) },
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === row.id ? { ...row } : null),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, { increment: bigint }> }) => {
        if (where.id !== row.id) throw new Error('no grant');
        row.billedBytes += data['billedBytes'].increment;
        row.purchasedBytes += data['purchasedBytes'].increment;
        return { ...row };
      },
    },
    wallet: {
      findUnique: async () => ({ ...wallet }),
      findUniqueOrThrow: async () => ({ ...wallet }),
      createMany: async () => ({ count: 0 }),
      updateMany: async ({ where, data }: { where: { id: string; version: number }; data: { cachedBalance: Prisma.Decimal; version: { increment: number } } }) => {
        if (where.id !== wallet.id || where.version !== wallet.version) return { count: 0 };
        wallet.cachedBalance = data.cachedBalance;
        wallet.version += data.version.increment;
        return { count: 1 };
      },
    },
    walletTransaction: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const created = { id: `ledger-${ledger.length + 1}`, ...data };
        ledger.push(created);
        return created;
      },
    },
    // Every ledger movement announces itself (F-111-m); `wallet-ledger.spec.ts` holds that.
    outboxEvent: { create: async ({ data }: { data: Record<string, unknown> }) => data },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, row, wallet, ledger };
}

describe('BlockPurchaseService.purchase', () => {
  const service = () => new BlockPurchaseService({} as never, new WalletLedgerService());
  const buy = (tx: Prisma.TransactionClient, targetBytes = GIB) =>
    service().purchase(tx, { grantId: GRANT, targetBytes });

  it('debits the wallet and advances both cursors by the same block', async () => {
    const { tx, row, ledger, wallet } = fakeTx({ id: GRANT }, D('10.00'));

    const block = await buy(tx);

    expect(block.amount.toFixed(2)).toBe('0.40');
    expect(row.purchasedBytes).toBe(block.bytes);
    expect(row.billedBytes).toBe(block.bytes);
    expect(wallet.cachedBalance.toFixed(2)).toBe('9.60');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      direction: LedgerDirection.debit,
      reasonType: WalletReasonType.traffic_consumption,
      referenceId: GRANT,
    });
  });

  it('adds to cursors that already moved, never overwrites them', async () => {
    const { tx, row } = fakeTx({ id: GRANT, billedBytes: BigInt(5), purchasedBytes: BigInt(5) }, D('10.00'));

    const block = await buy(tx);

    expect(row.purchasedBytes).toBe(BigInt(5) + block.bytes);
    expect(row.billedBytes).toBe(BigInt(5) + block.bytes);
  });

  it('buys the largest block the balance can fund rather than stalling on a full one', async () => {
    const { tx, wallet } = fakeTx({ id: GRANT }, D('0.13'));

    const block = await buy(tx);

    expect(block.amount.toFixed(2)).toBe('0.13');
    expect(wallet.cachedBalance.toFixed(2)).toBe('0.00');
  });

  it('refuses a balance under a cent, and writes nothing', async () => {
    const { tx, row, ledger } = fakeTx({ id: GRANT }, D('0.00'));

    await expect(buy(tx)).rejects.toMatchObject({ reason: 'insufficient_funds' });
    expect(row.purchasedBytes).toBe(BigInt(0));
    expect(ledger).toHaveLength(0);
  });

  it.each([
    [{ status: GrantStatus.suspended }, 'grant_not_active'],
    [{ billingMode: VariantBillingMode.prepaid, meteredRate: null }, 'grant_not_metered'],
    [{ meteredRate: null }, 'grant_not_metered'],
  ])('refuses %o with %s', async (patch, reason) => {
    const { tx, ledger } = fakeTx({ id: GRANT, ...patch }, D('10.00'));

    await expect(buy(tx)).rejects.toMatchObject({ reason });
    expect(ledger).toHaveLength(0);
  });

  it('answers a missing Grant as a refusal, not a crash', async () => {
    const { tx } = fakeTx({ id: 'other' }, D('10.00'));
    await expect(buy(tx)).rejects.toMatchObject({ reason: 'grant_not_found' });
  });

  it('refuses a target of zero: a block nobody asked for is not a purchase', async () => {
    const { tx, ledger } = fakeTx({ id: GRANT }, D('10.00'));
    await expect(buy(tx, BigInt(0))).rejects.toMatchObject({ reason: 'target_not_positive' });
    expect(ledger).toHaveLength(0);
  });
});
