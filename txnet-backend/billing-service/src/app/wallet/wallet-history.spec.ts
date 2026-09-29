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
  'reasonType.traffic_refund': 'بازگشت ترافیک مصرف‌نشده',
};

function ledgerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '66666666-6666-4666-8666-666666666666',
    amount: d('10.00'),
    direction: 'credit',
    reasonType: WalletReasonType.payment_gateway,
    referenceId: null,
    balanceAfter: d('30.00'),
    currencyCode: 'USD',
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
    taxApplied: d('0'),
    taxRatePercent: null,
    discountApplied: d('0'),
    amountCredited: d('10.00'),
    currencyCode: 'USD',
    chargedAmountMinor: BigInt(1000000),
    exchangeRateSnapshot: d('1000000'),
    gatewayTrackingCode: 'A0000000000000000000000000000001',
    gatewayReferenceId: null,
    cardPanMasked: null,
    failureCode: 'cancelled_by_user',
    createdAt: new Date('2026-09-10T09:00:00Z'),
    expiresAt: null,
    nextVerifyAt: null,
    gateway: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', displayName: 'زرین‌پال' },
    tenantGatewayConfig: null,
    ...overrides,
  };
}

type Setup = {
  wallet?: { id: string; cachedBalance: Prisma.Decimal; heldAmount: Prisma.Decimal; currencyCode: string } | null;
  /** The tenant's operating currency now (ADR-0098 part 1). */
  operating?: string;
  rows?: ReturnType<typeof ledgerRow>[];
  payments?: ReturnType<typeof paymentRow>[];
};

type Slice = { skip: number; take: number };

/**
 * Records the `where` each list was asked for, which is where a filter is lost,
 * and the `skip`/`take`, which is where a page is. The echoed `page` in the
 * answer is not enough on its own: it can be right while the query read the
 * wrong slice.
 */
function build({
  wallet = { id: WALLET, cachedBalance: d('30.00'), heldAmount: d('0'), currencyCode: 'USD' },
  operating = 'USD',
  rows = [ledgerRow()],
  payments = [paymentRow()],
}: Setup = {}) {
  const asked: {
    ledger?: Prisma.WalletTransactionWhereInput;
    payments?: Prisma.PaymentTransactionWhereInput;
    ledgerSlice?: Slice;
    paymentsSlice?: Slice;
  } = {};
  const tx = {
    $executeRaw: async () => 0,
    tenant: { findUnique: async () => ({ operatingCurrencyCode: operating }) },
    wallet: { findUnique: async () => wallet },
    walletTransaction: {
      findMany: async (args: { where: Prisma.WalletTransactionWhereInput } & Slice) => {
        asked.ledger = args.where;
        asked.ledgerSlice = { skip: args.skip, take: args.take };
        return rows;
      },
      count: async () => rows.length,
    },
    paymentTransaction: {
      findMany: async (args: { where: Prisma.PaymentTransactionWhereInput } & Slice) => {
        asked.payments = args.where;
        asked.paymentsSlice = { skip: args.skip, take: args.take };
        return payments;
      },
      count: async () => payments.length,
      findFirst: async (args: { where: Prisma.PaymentTransactionWhereInput }) => {
        asked.payments = args.where;
        return payments[0] ?? null;
      },
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

    expect(result).toEqual({ balance: '0.00', held: '0.00', available: '0.00', currencyCode: 'USD', total: 0, page: 1, pageSize: 10, rows: [] });
  });

  it('answers held money apart, and available as the balance less it (F-118-j)', async () => {
    const { service } = build({ wallet: { id: WALLET, cachedBalance: d('30.00'), heldAmount: d('7.25'), currencyCode: 'USD' } });
    const result = await runWithTenant({ id: TENANT }, () => service.ledger({ userId: USER, lang: 'fa', ...page }));

    // `balance` stays `cachedBalance`: the ledger's `balanceAfter` column is the same figure, rows and header agree.
    expect(result).toMatchObject({ balance: '30.00', held: '7.25', available: '22.75' });
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

  it('leaves traffic out of a page nobody narrowed (F-027-am)', async () => {
    const { service, asked } = build();
    await runWithTenant({ id: TENANT }, () => service.ledger({ userId: USER, lang: 'fa', ...page }));

    // Named, not `notIn`: every other type is listed, so a reason added to the
    // enum is carried by this page rather than silently joining the excluded.
    expect(asked.ledger?.reasonType).toEqual({
      in: [
        WalletReasonType.payment_gateway,
        WalletReasonType.coupon_redemption,
        WalletReasonType.admin_manual_adjust,
        WalletReasonType.affiliate_commission,
        WalletReasonType.sub_account_charge,
        WalletReasonType.wallet_transfer_in,
        WalletReasonType.wallet_transfer_out,
        WalletReasonType.reseller_purchase,
        // Money coming **back** to the user (F-027-r). The default hides the
        // hundreds of block debits, not the one row that returns their
        // remainder — which is the rule above working, not an exception to it.
        WalletReasonType.traffic_refund,
        // A product bought from the wallet (F-111-b), joined by the same rule.
        WalletReasonType.product_purchase,
        // And its refund when it was never delivered (F-111-d).
        WalletReasonType.product_refund,
        // A balance restated in a new currency (F-116-f): the user should see why it changed.
        WalletReasonType.currency_change,
        WalletReasonType.usage_charge,
        WalletReasonType.usage_refund,
      ],
    });
  });

  it('answers traffic rows to a caller that asked for them by type (F-027-am)', async () => {
    const { service, asked } = build();
    await runWithTenant({ id: TENANT }, () =>
      service.ledger({ userId: USER, lang: 'fa', types: [WalletReasonType.traffic_consumption], ...page }),
    );

    expect(asked.ledger?.reasonType).toEqual({ in: [WalletReasonType.traffic_consumption] });
  });

  it('answers traffic rows to a term that matched their label, never an empty page (F-027-am)', async () => {
    const { service, asked } = build();
    const result = await runWithTenant({ id: TENANT }, () =>
      service.ledger({ userId: USER, lang: 'fa', search: 'ترافیک', ...page }),
    );

    // Both labels carry the word, so both types are answered: the fold matches
    // what the user typed, and the refund of traffic is traffic to them.
    expect(asked.ledger?.reasonType).toEqual({
      in: [WalletReasonType.traffic_consumption, WalletReasonType.traffic_refund],
    });
    expect(result.total).toBe(1);
  });

  it('bounds the page by the wallet and the date range it was given', async () => {
    const { service, asked } = build();
    const from = new Date('2026-09-01T00:00:00Z');
    const to = new Date('2026-09-30T23:59:59Z');
    await runWithTenant({ id: TENANT }, () => service.ledger({ userId: USER, lang: 'fa', from, to, ...page }));

    expect(asked.ledger?.walletId).toBe(WALLET);
    expect(asked.ledger?.createdAt).toEqual({ gte: from, lte: to });
  });

  /**
   * The defaults moved out of the schema and into the service on 2026-09-12
   * (`wallet-history.schema.ts` says why), so nothing but this says what an
   * absent page means. Both routes must agree, which is why `payments` asserts
   * it too rather than trusting that one helper serves both.
   */
  it('reads the first page of ten when the query named no page, and the asked-for slice when it did', async () => {
    const first = build();
    const answer = await runWithTenant({ id: TENANT }, () => first.service.ledger({ userId: USER, lang: 'fa' }));
    expect(first.asked.ledgerSlice).toEqual({ skip: 0, take: 10 });
    expect(answer).toMatchObject({ page: 1, pageSize: 10 });

    const asked = build();
    const third = await runWithTenant({ id: TENANT }, () =>
      asked.service.ledger({ userId: USER, lang: 'fa', page: 3, pageSize: 25 }),
    );
    expect(asked.asked.ledgerSlice).toEqual({ skip: 50, take: 25 });
    expect(third).toMatchObject({ page: 3, pageSize: 25 });
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

  it('answers the tax a payment was charged and the rate frozen on it, and none when untaxed (F-104-ah)', async () => {
    const { service } = build({
      payments: [paymentRow({ taxApplied: d('9'), taxRatePercent: d('9.5000') }), paymentRow()],
    });
    const result = await runWithTenant({ id: TENANT }, () => service.payments({ userId: USER, ...page }));

    expect(result.rows[0]).toMatchObject({ tax: '9.00', taxRatePercent: '9.5' });
    expect(result.rows[1]).toMatchObject({ tax: '0.00', taxRatePercent: null });
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

  it('reads the first page of ten when the query named no page, and the asked-for slice when it did', async () => {
    const first = build();
    const answer = await runWithTenant({ id: TENANT }, () => first.service.payments({ userId: USER }));
    expect(first.asked.paymentsSlice).toEqual({ skip: 0, take: 10 });
    expect(answer).toMatchObject({ page: 1, pageSize: 10 });

    const asked = build();
    const second = await runWithTenant({ id: TENANT }, () => asked.service.payments({ userId: USER, page: 2, pageSize: 50 }));
    expect(asked.asked.paymentsSlice).toEqual({ skip: 50, take: 50 });
    expect(second).toMatchObject({ page: 2, pageSize: 50 });
  });

  it('says a pending payment is verifying while its retry clock runs (F-093-l)', async () => {
    const { service } = build({
      payments: [paymentRow({ status: 'pending', nextVerifyAt: new Date('2026-09-14T10:00:00Z') }), paymentRow({ status: 'failed' })],
    });
    const result = await runWithTenant({ id: TENANT }, () => service.payments({ userId: USER, ...page }));
    expect(result.rows.map((r) => r.verifying)).toEqual([true, false]);
  });
});

describe('WalletHistoryService.payment', () => {
  it("answers one of the caller's own payments, by id and user together (F-093-l)", async () => {
    const { service, asked } = build({ payments: [paymentRow({ status: 'pending', nextVerifyAt: new Date() })] });
    const row = await runWithTenant({ id: TENANT }, () => service.payment(USER, '77777777-7777-4777-8777-777777777777'));

    expect(asked.payments).toEqual({ id: '77777777-7777-4777-8777-777777777777', userId: USER });
    expect(row).toMatchObject({ status: 'pending', verifying: true });
  });

  it('answers null for a payment that is not the caller’s', async () => {
    const { service } = build({ payments: [] });
    expect(await runWithTenant({ id: TENANT }, () => service.payment(USER, '77777777-7777-4777-8777-777777777777'))).toBeNull();
  });
});

/**
 * F-116-h2 (ADR-0098 part 3): every amount names the currency it is in, and
 * that is the row's own — never the tenant's now. A tenant that switched from
 * USD to IRR still has USD rows in its ledger; read with the tenant's
 * currency, a $10 top-up would show as 10 rials.
 */
describe('WalletHistoryService — each amount names its own currency', () => {
  it("labels each ledger row with its own currency, and the balance with the wallet's", async () => {
    const { service } = build({
      wallet: { id: WALLET, cachedBalance: d('600000.00'), heldAmount: d('0'), currencyCode: 'IRR' },
      operating: 'IRR',
      rows: [
        ledgerRow({ id: 'opening', reasonType: WalletReasonType.currency_change, amount: d('600000.00'), balanceAfter: d('600000.00'), currencyCode: 'IRR' }),
        ledgerRow({ id: 'closing', reasonType: WalletReasonType.currency_change, direction: 'debit', amount: d('10.00'), balanceAfter: d('0.00'), currencyCode: 'USD' }),
      ],
    });

    const result = await runWithTenant({ id: TENANT }, () => service.ledger({ userId: USER, lang: 'fa', ...page }));

    expect(result.balance).toBe('600000.00');
    expect(result.currencyCode).toBe('IRR');
    expect(result.rows.map((r) => [r.id, r.amount, r.currencyCode])).toEqual([
      ['opening', '600000.00', 'IRR'],
      ['closing', '10.00', 'USD'],
    ]);
  });

  it("names the tenant's operating currency for a user with no wallet yet — the one its first credit will be in", async () => {
    const { service } = build({ wallet: null, operating: 'IRR' });

    const result = await runWithTenant({ id: TENANT }, () => service.ledger({ userId: USER, lang: 'fa', ...page }));

    expect(result).toMatchObject({ balance: '0.00', currencyCode: 'IRR', rows: [] });
  });

  it("names the wallet's currency when a search matches no label, as for a full page", async () => {
    const { service } = build({ wallet: { id: WALLET, cachedBalance: d('5.00'), heldAmount: d('0'), currencyCode: 'EUR' }, operating: 'IRR' });

    const result = await runWithTenant({ id: TENANT }, () => service.ledger({ userId: USER, lang: 'fa', search: 'no-such-label', ...page }));

    expect(result).toMatchObject({ balance: '5.00', currencyCode: 'EUR', rows: [] });
  });

  it("labels a payment with the currency it was asked in, not the tenant's now", async () => {
    const { service } = build({ operating: 'IRR', payments: [paymentRow({ currencyCode: 'USD' })] });

    const list = await runWithTenant({ id: TENANT }, () => service.payments({ userId: USER, ...page }));
    const one = await runWithTenant({ id: TENANT }, () => service.payment(USER, '77777777-7777-4777-8777-777777777777'));

    expect(list.rows[0]).toMatchObject({ amountRequested: '10.00', currencyCode: 'USD' });
    expect(one).toMatchObject({ currencyCode: 'USD' });
  });
});
