/**
 * The remainder credit (F-027-r; ADR-0072 rule 3).
 *
 * What breaks without anyone seeing it:
 *  - **a forgotten debt.** Bytes bought ahead of consumption are real money out
 *    of the wallet; a Grant that closes without giving the unserved ones back
 *    keeps money for service nobody received — ADR-0072's accepted cost turning
 *    into a charge;
 *  - **paying it twice.** The credit is idempotent through the money cursor:
 *    `billedBytes` comes down by exactly what was refunded, so a second close —
 *    a retried sweeper, a cancel racing an expiry — finds nothing left;
 *  - **giving back more than was taken.** The remainder is priced and rounded
 *    **down** to a whole cent, the mirror of `sizeBlock`'s round up, so a
 *    refund never exceeds what the blocks cost;
 *  - **refunding what was served.** Only `billedBytes - consumedBytes` is
 *    unconsumed; a Grant that used everything it bought gets nothing back, and
 *    one reported past its ceiling (ADR-0074) is not refunded into the red;
 *  - **an open Grant refunded.** Only a closed Grant is settled — refunding a
 *    live one would return money its next block buys back a second later.
 */
import { GrantStatus, LedgerDirection, Prisma, VariantBillingMode, WalletReasonType } from '@prisma/client';

import { WalletCreditService } from '../wallet/wallet-credit.service';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import { GIB } from './block-purchase';
import { RemainderCreditRefused, RemainderCreditService, sizeRemainder } from './remainder-credit';

const D = (v: string | number) => new Prisma.Decimal(v);
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '77777777-7777-4777-8777-777777777777';

describe('sizeRemainder', () => {
  /** $0.40 per GiB — ADR-0073's worked example, as `block-purchase.spec.ts` uses. */
  const rate = D('0.40000000');

  it('prices the remainder and rounds the price down to a whole cent', () => {
    // 100 MiB at $0.40/GiB is $0.0390625 — 3c back, never 4c and never the fraction.
    const back = sizeRemainder({ rate, remainderBytes: BigInt(100) * BigInt(1024 * 1024) });
    expect(back.amount.toFixed(2)).toBe('0.03');
    expect(back.amount.decimalPlaces()).toBeLessThanOrEqual(2);
  });

  it('gives back at most the bytes those cents paid for', () => {
    const remainderBytes = BigInt(100) * BigInt(1024 * 1024);
    const back = sizeRemainder({ rate, remainderBytes });
    expect(back.bytes <= remainderBytes).toBe(true);
    // 3c buys 0.03 / 0.40 GiB; the floor is what comes off the cursor.
    expect(back.bytes.toString()).toBe(D('0.03').div(rate).mul(GIB.toString()).floor().toFixed(0));
  });

  it('refuses a remainder worth less than a cent rather than writing a sub-cent row', () => {
    const dust = () => sizeRemainder({ rate, remainderBytes: BigInt(1024) });
    expect(dust).toThrow(RemainderCreditRefused);
    expect(dust).toThrow(expect.objectContaining({ reason: 'nothing_to_credit' }));
  });

  it('refuses a rate it cannot price with, exactly as the purchase does', () => {
    const priceable = expect.objectContaining({ reason: 'rate_not_priceable' });
    expect(() => sizeRemainder({ rate: D('0'), remainderBytes: GIB })).toThrow(priceable);
    expect(() => sizeRemainder({ rate: D('0.000000001'), remainderBytes: GIB })).toThrow(priceable);
  });
});

type GrantRow = {
  id: string;
  userId: string;
  status: GrantStatus;
  billingMode: VariantBillingMode;
  meteredRate: Prisma.Decimal | null;
  meteredRateCurrencyCode: string | null;
  billedBytes: bigint;
  purchasedBytes: bigint;
  consumedBytes: bigint;
};

/** The same store shape `block-purchase.spec.ts` uses, so the real ledger runs here. */
function fakeTx(grant: Partial<GrantRow> & { id: string }, balance: Prisma.Decimal) {
  const row: GrantRow = {
    userId: USER,
    status: GrantStatus.expired,
    billingMode: VariantBillingMode.metered,
    meteredRate: D('0.40000000'),
    meteredRateCurrencyCode: 'USD',
    billedBytes: GIB,
    purchasedBytes: GIB,
    consumedBytes: BigInt(0),
    ...grant,
  };
  const wallet = { id: 'wallet-1', ownerUserId: USER, currencyCode: 'USD', cachedBalance: balance, heldAmount: new Prisma.Decimal(0), version: 0 };
  const ledger: Array<Record<string, unknown>> = [];

  const tx = {
    // Every tenant here keeps its books in USD (F-116-b).
    tenant: { findUnique: async () => ({ operatingCurrencyCode: 'USD' }), findFirst: async () => ({ operatingCurrencyCode: 'USD' }) },
    grant: {
      findUnique: async ({ where }: { where: { id: string } }) => (where.id === row.id ? { ...row } : null),
      // The credit now also asks what this user's refund revives (F-027-ap,
      // ADR-0079). This user holds nothing suspended; `revival.spec.ts` owns
      // the case where they do.
      findMany: async () => [],
      updateMany: async ({ where, data }: { where: { id: string; billedBytes: bigint }; data: { billedBytes: { decrement: bigint } } }) => {
        if (where.id !== row.id || where.billedBytes !== row.billedBytes) return { count: 0 };
        row.billedBytes -= data.billedBytes.decrement;
        return { count: 1 };
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

describe('RemainderCreditService.credit', () => {
  const service = () => new RemainderCreditService({} as never, new WalletCreditService(new WalletLedgerService()));
  const close = (tx: Prisma.TransactionClient) => service().credit(tx, { grantId: GRANT });

  it('credits the unconsumed bytes back and brings the money cursor down with them', async () => {
    const { tx, row, ledger, wallet } = fakeTx({ id: GRANT }, D('1.00'));

    const back = await close(tx);

    // A whole GiB bought at 40c and nothing served: 40c back.
    expect(back.amount.toFixed(2)).toBe('0.40');
    expect(wallet.cachedBalance.toFixed(2)).toBe('1.40');
    expect(row.billedBytes).toBe(GIB - back.bytes);
    // What was *bought* is history; only the money cursor moves (ADR-0074).
    expect(row.purchasedBytes).toBe(GIB);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      direction: LedgerDirection.credit,
      reasonType: WalletReasonType.traffic_refund,
      referenceId: GRANT,
    });
  });

  it('refunds only what was not consumed', async () => {
    const consumedBytes = GIB / BigInt(2);
    const { tx, row } = fakeTx({ id: GRANT, consumedBytes }, D('0.00'));

    const back = await close(tx);

    expect(back.amount.toFixed(2)).toBe('0.20');
    expect(row.billedBytes >= consumedBytes).toBe(true);
  });

  it('pays the remainder once: a second close finds nothing left', async () => {
    const { tx, ledger } = fakeTx({ id: GRANT }, D('0.00'));

    await close(tx);
    await expect(close(tx)).rejects.toMatchObject({ reason: 'nothing_to_credit' });
    expect(ledger).toHaveLength(1);
  });

  it('gives nothing back to a Grant reported past what it bought', async () => {
    const { tx, ledger } = fakeTx({ id: GRANT, consumedBytes: GIB * BigInt(2) }, D('0.00'));

    await expect(close(tx)).rejects.toMatchObject({ reason: 'nothing_to_credit' });
    expect(ledger).toHaveLength(0);
  });

  it('loses to a writer that moved the cursor first, with nothing written', async () => {
    const { tx, row, ledger } = fakeTx({ id: GRANT }, D('0.00'));
    const raced = service().credit(tx, { grantId: GRANT });
    row.billedBytes += BigInt(1); // a block bought between the read and the guard

    await expect(raced).rejects.toThrow(/cursor/i);
    expect(ledger).toHaveLength(0);
  });

  it.each([
    [{ status: GrantStatus.active }, 'grant_not_closed'],
    [{ status: GrantStatus.suspended }, 'grant_not_closed'],
    [{ billingMode: VariantBillingMode.prepaid, meteredRate: null }, 'grant_not_metered'],
    [{ meteredRate: null }, 'grant_not_metered'],
  ])('refuses %o with %s', async (patch, reason) => {
    const { tx, ledger } = fakeTx({ id: GRANT, ...patch }, D('0.00'));

    await expect(close(tx)).rejects.toMatchObject({ reason });
    expect(ledger).toHaveLength(0);
  });

  it.each([GrantStatus.expired, GrantStatus.cancelled, GrantStatus.exhausted])('settles a %s Grant', async (status) => {
    const { tx } = fakeTx({ id: GRANT, status }, D('0.00'));
    await expect(close(tx)).resolves.toMatchObject({ grantId: GRANT });
  });

  it('answers a missing Grant as a refusal, not a crash', async () => {
    const { tx } = fakeTx({ id: 'other' }, D('0.00'));
    await expect(close(tx)).rejects.toMatchObject({ reason: 'grant_not_found' });
  });
});
