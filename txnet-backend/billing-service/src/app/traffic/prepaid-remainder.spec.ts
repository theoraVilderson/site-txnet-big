/**
 * A deleted prepaid Grant's remainder (F-311-m, user 2026-09-28). What would
 * break quietly here, and nowhere else:
 *
 *  - **the larger share used decides**: both volume and time were sold, so
 *    what comes back is `total × (1 − max(volume used, time gone))` — never
 *    the unused share of only one of them. 30 days / 50 GiB for $10, deleted
 *    on day 12 with 10 GiB used, is $6.00, not $8.00;
 *  - an unlimited Grant is measured by time alone, a permanent one by volume;
 *  - **rounded down to a cent, never above what was paid**, and only what was
 *    paid: a Grant not bought with money (admin, trial, coupon, a free
 *    invoice) gives nothing back;
 *  - a frozen Grant's clock stopped when it froze — its frozen days are not "gone";
 *  - the money goes back as `product_refund` against the invoice, so the
 *    reseller's revenue nets it like any refund of a sale.
 */
import { GrantSource, Prisma, VariantBillingMode, WalletReasonType } from '@prisma/client';

import { creditPrepaidRemainder, sizePrepaidRemainder } from './prepaid-remainder';
import { RemainderCreditRefused } from './remainder-credit';

const GIB = BigInt(1024 ** 3);
const DAY = 86_400_000;
const GRANT = '99999999-9999-4999-8999-999999999991';
const INVOICE = '88888888-8888-4888-8888-888888888888';
const USER = '66666666-6666-4666-8666-666666666666';
const start = new Date('2026-09-01T00:00:00Z');
const end = new Date(start.getTime() + 30 * DAY);
const day12 = new Date(start.getTime() + 12 * DAY);

const refused = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(RemainderCreditRefused);
    return (e as RemainderCreditRefused).reason;
  }
  throw new Error('not refused');
};

describe('sizePrepaidRemainder', () => {
  const base = { totalCents: BigInt(1000), startsAt: start, endsAt: end as Date | null, stoppedAt: day12, usedBytes: BigInt(10) * GIB, quotaBytes: BigInt(50) * GIB, unlimited: false };

  it('takes the larger share used: 40 % of the time beats 20 % of the volume — $6.00 of $10', () => {
    expect(sizePrepaidRemainder(base)).toBe(BigInt(600));
  });

  it('volume decides when more of it is gone: 45 of 50 GiB on day 12 is $1.00', () => {
    expect(sizePrepaidRemainder({ ...base, usedBytes: BigInt(45) * GIB })).toBe(BigInt(100));
  });

  it('rounds down to a cent', () => {
    // 1/3 of the time gone of $10.00 leaves 666.67 cents -> 666.
    expect(sizePrepaidRemainder({ ...base, usedBytes: BigInt(0), stoppedAt: new Date(start.getTime() + 10 * DAY) })).toBe(BigInt(666));
  });

  it('measures an unlimited Grant by time alone and a permanent one by volume alone', () => {
    expect(sizePrepaidRemainder({ ...base, unlimited: true, quotaBytes: BigInt(0), usedBytes: BigInt(999) * GIB })).toBe(BigInt(600));
    expect(sizePrepaidRemainder({ ...base, endsAt: null })).toBe(BigInt(800));
  });

  it('never gives back more than was paid, even deleted before it started', () => {
    expect(sizePrepaidRemainder({ ...base, usedBytes: BigInt(0), stoppedAt: new Date(start.getTime() - DAY) })).toBe(BigInt(1000));
  });

  it('refuses a Grant with everything used, or nothing it can be measured by', () => {
    expect(refused(() => sizePrepaidRemainder({ ...base, stoppedAt: end }))).toBe('nothing_to_credit');
    expect(refused(() => sizePrepaidRemainder({ ...base, usedBytes: BigInt(60) * GIB }))).toBe('nothing_to_credit');
    expect(refused(() => sizePrepaidRemainder({ ...base, unlimited: true, endsAt: null }))).toBe('not_measurable');
  });
});

describe('creditPrepaidRemainder', () => {
  function build(grant: Record<string, unknown>, invoice: Record<string, unknown> | null = { id: INVOICE, userId: USER, total: new Prisma.Decimal('10.00') }) {
    const credits: Record<string, unknown>[] = [];
    const tx = {
      grant: {
        findUnique: async () => ({
          id: GRANT,
          userId: USER,
          status: 'cancelled',
          billingMode: VariantBillingMode.prepaid,
          source: GrantSource.purchase,
          sourceReferenceId: INVOICE,
          startsAt: start,
          endsAt: end,
          purchasedBytes: BigInt(50) * GIB,
          trafficUnlimited: false,
          ...grant,
        }),
      },
      invoice: { findFirst: async () => invoice },
      config: { findMany: async () => [{ counterState: { lifetimeUpBytes: BigInt(4) * GIB, lifetimeDownBytes: BigInt(6) * GIB } }] },
    };
    const ledger = {
      credit: async (_tx: unknown, row: Record<string, unknown>) => {
        credits.push(row);
        return { id: 'wallet-row-1' };
      },
    };
    return { tx: tx as never, ledger: ledger as never, credits };
  }

  it('credits the remainder of the invoice as product_refund, against the invoice', async () => {
    const { tx, ledger, credits } = build({});
    const out = await creditPrepaidRemainder(tx, ledger, { grantId: GRANT, at: day12, stoppedAt: null });
    expect(out).toEqual({ amount: new Prisma.Decimal('6'), walletTransactionId: 'wallet-row-1' });
    expect(credits).toEqual([{ userId: USER, amount: new Prisma.Decimal('6'), reasonType: WalletReasonType.product_refund, referenceId: INVOICE }]);
  });

  it('measures time to the moment a frozen Grant stopped, not to the delete', async () => {
    const { tx, ledger } = build({});
    const out = await creditPrepaidRemainder(tx, ledger, { grantId: GRANT, at: new Date(start.getTime() + 25 * DAY), stoppedAt: day12 });
    expect(out.amount).toEqual(new Prisma.Decimal('6'));
  });

  it('gives nothing back for a Grant not bought with money', async () => {
    for (const source of [GrantSource.admin_grant, GrantSource.trial, GrantSource.coupon]) {
      const { tx, ledger, credits } = build({ source });
      await expect(creditPrepaidRemainder(tx, ledger, { grantId: GRANT, at: day12, stoppedAt: null })).rejects.toMatchObject({ reason: 'nothing_paid' });
      expect(credits).toHaveLength(0);
    }
    const free = build({}, { id: INVOICE, userId: USER, total: new Prisma.Decimal('0.00') });
    await expect(creditPrepaidRemainder(free.tx, free.ledger, { grantId: GRANT, at: day12, stoppedAt: null })).rejects.toMatchObject({ reason: 'nothing_paid' });
    const gone = build({}, null);
    await expect(creditPrepaidRemainder(gone.tx, gone.ledger, { grantId: GRANT, at: day12, stoppedAt: null })).rejects.toMatchObject({ reason: 'nothing_paid' });
  });

  it('refuses a live Grant and a metered one — each has its own path', async () => {
    const live = build({ status: 'active' });
    await expect(creditPrepaidRemainder(live.tx, live.ledger, { grantId: GRANT, at: day12, stoppedAt: null })).rejects.toMatchObject({ reason: 'grant_not_closed' });
    const metered = build({ billingMode: VariantBillingMode.metered });
    await expect(creditPrepaidRemainder(metered.tx, metered.ledger, { grantId: GRANT, at: day12, stoppedAt: null })).rejects.toMatchObject({ reason: 'grant_not_prepaid' });
  });
});
