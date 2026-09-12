/**
 * The panel's financial page, read side (F-092-n).
 *
 * What would break silently here, and nowhere else:
 *  - the balance column. Legacy rebuilt it by walking back from the current
 *    balance and subtracting every row it had skipped — counting pending and
 *    failed top-ups as if they had moved money, so one failed attempt skewed
 *    every row above it. Here `balanceAfter` is the column the ledger wrote and
 *    nothing recomputes it;
 *  - the search. A Persian user types `كيف` with the Arabic `ك` and `ي`, or with
 *    a space where the label has a ZWNJ, and expects the same rows. Folding
 *    that is the whole reason the legacy regex is ported;
 *  - a search that matches no label must answer an empty page, never every row:
 *    the term resolves to a set of reason types, and an empty set is a filter,
 *    not an absent one;
 *  - payment attempts are not ledger rows. A `pending` or `failed` top-up moved
 *    no money and must never appear in a balance-carrying list.
 *
 * Which rows RLS lets a tenant see is `wallet-ledger.int.spec.ts`'s job, not
 * this file's.
 */
import { Prisma, WalletReasonType } from '@prisma/client';
import { runWithTenant } from '@txnet-backend/shared-core';

import { foldedSearch, matchesFolded } from './persian-search';
import { WalletHistoryService } from './wallet-history.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const WALLET = '55555555-5555-4555-8555-555555555555';

const d = (v: string) => new Prisma.Decimal(v);

const LABELS: Record<string, string> = {
  'reasonType.payment_gateway': 'شارژ کیف پول از درگاه پرداخت',
  'reasonType.coupon_redemption': 'کد هدیه',
  'reasonType.traffic_consumption': 'مصرف ترافیک',
  'reasonType.admin_manual_adjust': 'اصلاح دستی توسط پشتیبانی',
  'reasonType.affiliate_commission': 'پورسانت معرفی دوستان',
  'reasonType.sub_account_charge': 'شارژ اکانت فرعی',
  'reasonType.wallet_transfer_in': 'انتقال دریافتی از کیف پول دیگر',
  'reasonType.wallet_transfer_out': 'انتقال به کیف پول دیگر',
};

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    amount: d('10.00'),
    direction: 'credit',
    reasonType: WalletReasonType.payment_gateway,
    referenceId: null,
    balanceAfter: d('30.00'),
    createdAt: new Date('2026-09-10T10:00:00Z'),
    ...overrides,
  };
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    status: 'failed',
    amountRequested: d('10.00'),
    feeApplied: d('0.10'),
    discountApplied: d('0'),
    amountCredited: d('10.00'),
    chargedAmountMinor: BigInt(1000000),
    exchangeRateSnapshot: d('1000000'),
    gatewayTrackingCode: 'A0000000000000000000000000000001',
    gatewayReferenceId: null,
    cardPanMasked: null,
    failureCode: 'cancelled_by_user',
    createdAt: new Date('2026-09-10T09:00:00Z'),
    expiresAt: null,
    gateway: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'زرین‌پال' },
    tenantGatewayConfig: null,
    ...overrides,
  };
}

type Setup = {
  wallet?: { id: string; cachedBalance: Prisma.Decimal } | null;
  rows?: ReturnType<typeof ledgerRow>[];
  payments?: ReturnType<typeof paymentRow>[];
};

/** Records the `where` each list was asked for, which is where a filter is lost. */
function build({ wallet = { id: WALLET, cachedBalance: d('30.00') }, rows = [ledgerRow()], payments = [paymentRow()] }: Setup = {}) {
  const asked: { ledger?: Prisma.WalletTransactionWhereInput; payments?: Prisma.PaymentTransactionWhereInput } = {};
  const tx = {
    $executeRaw: async () => 0,
    wallet: { findUnique: async () => wallet },
    walletTransaction: {
      findMany: async (args: { where: Prisma.WalletTransactionWhereInput }) => {
        asked.ledger = args.where;
        return rows;
      },
      count: async () => rows.length,
    },
    paymentTransaction: {
      findMany: async (args: { where: Prisma.PaymentTransactionWhereInput }) => {
        asked.payments = args.where;
        return payments;
      },
      count: async () => payments.length,
    },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const locale = {
    getKey: (_lang: string, namespace: string, key: string) => (namespace === 'billing' ? LABELS[key] : undefined),
    getDefaultLanguage: () => 'fa',
  };
  const service = new WalletHistoryService(prisma as never, locale as never);
  return { service, asked };
}

const page = { page: 1, pageSize: 10 };

describe('persian-search', () => {
  it('folds the letter variants a Persian keyboard disagrees about', () => {
    expect(matchesFolded('كيف', 'شارژ کیف پول از درگاه پرداخت')).toBe(true);
    expect(matchesFolded('کیف', 'شارژ کیف پول از درگاه پرداخت')).toBe(true);
    expect(matchesFolded('اصلاح', 'اصلاح دستی توسط پشتیبانی')).toBe(true);
    expect(matchesFolded('آصلاح', 'اصلاح دستی توسط پشتیبانی')).toBe(true);
  });

  it('reads a space and a ZWNJ as the same gap, in the term as well as in the text', () => {
    expect(matchesFolded('زرین پال', 'زرین‌پال')).toBe(true);
    expect(matchesFolded('زرین‌پال', 'زرین پال')).toBe(true);
  });

  it('matches the term as text, never as a pattern', () => {
    expect(matchesFolded('کد.هدیه', 'کد هدیه')).toBe(false);
    expect(() => foldedSearch('([')).not.toThrow();
  });

  it('has nothing to search for in a blank term', () => {
    expect(foldedSearch('   ')).toBeNull();
  });
});

describe('WalletHistoryService.ledger', () => {
  it('answers the balance the ledger wrote, and never recomputes a row', async () => {
    const { service } = build({
      rows: [
        ledgerRow({ id: 'a', balanceAfter: d('30.00'), amount: d('10.00'), direction: 'credit' }),
        ledgerRow({ id: 'b', balanceAfter: d('20.00'), amount: d('5.00'), direction: 'debit' }),
      ],
    });
    const result = await runWithTenant({ id: TENANT }, () => service.ledger({ userId: USER, lang: 'fa', ...page }));

    expect(result.balance).toBe('30.00');
    expect(result.rows.map((r) => r.balanceAfter)).toEqual(['30.00', '20.00']);
    expect(result.total).toBe(2);
  });

  it('is an empty page, not an error, for a user with no wallet yet', async () => {
    const { service } = build({ wallet: null });
    const result = await runWithTenant({ id: TENANT }, () => service.ledger({ userId: USER, lang: 'fa', ...page }));

    expect(result).toEqual({ balance: '0.00', total: 0, page: 1, pageSize: 10, rows: [] });
  });

  it('turns a search term into the reason types whose label matches it', async () => {
    const { service, asked } = build();
    await runWithTenant({ id: TENANT }, () =>
      service.ledger({ userId: USER, lang: 'fa', search: 'انتقال', ...page }),
    );

    expect(asked.ledger?.reasonType).toEqual({
      in: [WalletReasonType.wallet_transfer_in, WalletReasonType.wallet_transfer_out],
    });
  });

  it('answers an empty page when the term matches no label — never the whole ledger', async () => {
    const { service, asked } = build();
    const result = await runWithTenant({ id: TENANT }, () =>
      service.ledger({ userId: USER, lang: 'fa', search: 'هیچ‌چیز', ...page }),
    );

    expect(result.rows).toEqual([]);
    expect(result.total).toBe(0);
    // The database was never asked: an empty set of types is a filter, and one
    // dropped on the way to the query answers every row instead of none.
    expect(asked.ledger).toBeUndefined();
  });

  it('intersects the search with an explicit type filter rather than replacing it', async () => {
    const { service, asked } = build();
    await runWithTenant({ id: TENANT }, () =>
      service.ledger({
        userId: USER,
        lang: 'fa',
        search: 'انتقال',
        types: [WalletReasonType.wallet_transfer_out, WalletReasonType.payment_gateway],
        ...page,
      }),
    );

    expect(asked.ledger?.reasonType).toEqual({ in: [WalletReasonType.wallet_transfer_out] });
  });

  it('bounds the page by the wallet and the date range it was given', async () => {
    const { service, asked } = build();
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-30T23:59:59Z');
    await runWithTenant({ id: TENANT }, () => service.ledger({ userId: USER, lang: 'fa', from, to, ...page }));

    expect(asked.ledger?.walletId).toBe(WALLET);
    expect(asked.ledger?.createdAt).toEqual({ gte: from, lte: to });
  });
});

describe('WalletHistoryService.payments', () => {
  it('lists attempts that moved no money, with the gateway that was tried', async () => {
    const { service, asked } = build();
    const result = await runWithTenant({ id: TENANT }, () => service.payments({ userId: USER, ...page }));

    expect(asked.payments?.userId).toBe(USER);
    expect(result.rows[0]).toMatchObject({
      status: 'failed',
      amountRequested: '10.00',
      fee: '0.10',
      gateway: { source: 'platform', displayName: 'زرین‌پال' },
    });
    // A failed attempt has no balance of its own: it never reached the ledger.
    expect(result.rows[0]).not.toHaveProperty('balanceAfter');
  });

  it("names the reseller's own gateway as its own source", async () => {
    const { service } = build({
      payments: [
        paymentRow({
          gateway: null,
          tenantGatewayConfig: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', displayName: 'درگاه فروشنده' },
        }),
      ],
    });
    const result = await runWithTenant({ id: TENANT }, () => service.payments({ userId: USER, ...page }));

    expect(result.rows[0].gateway).toEqual({
      source: 'tenant',
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      displayName: 'درگاه فروشنده',
    });
  });
});
