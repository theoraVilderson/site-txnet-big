/**
 * The Customers tab and the renewal figure (F-1001-f, billing/contract.analytics.md
 * "Renewal" and the `customers` row).
 *
 * The ways this goes wrong quietly:
 *
 *  - **pending inside the rate.** A Grant whose window is still open has not
 *    renewed *yet*; counting it as lapsed sinks the rate every Monday. The
 *    rate is renewed ÷ (renewed + lapsed), `pending` beside it;
 *  - **a rate out of nothing.** No ended Grant is no rate, never 0% or NaN;
 *  - **people in the platform's view of a reseller.** Its top customers are
 *    never listed, and a signup bucket or a product's renewal under 5 people
 *    is hidden (ADR-0104 (3));
 *  - **a window outside 1..30.** The setting is refused at the edge, and an
 *    unset tenant reads the default 7.
 */
import { Prisma } from '@prisma/client';

import { contextOf } from './analytics-context';
import { customersOf, renewalOf } from './analytics-customers';
import { dayBounds } from './analytics-days';
import { writeGrantEnds } from './analytics-rollup-customers';
import { RENEWAL_WINDOW_DEFAULT_DAYS, analyticsSettingsSchema } from './analytics-settings';
import { analyticsQuerySchema } from './analytics.schema';

const PRODUCT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRODUCT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_1 = '44444444-4444-4444-8444-444444444441';

const d = (v: string) => new Prisma.Decimal(v);

/** Answers each read by the table it names; a split by product answers two products. */
function tx(window: number | null) {
  return {
    analyticsSetting: { findFirst: async () => (window === null ? null : { renewalWindowDays: window }) },
    user: { findMany: async () => [{ id: USER_1, fullName: 'Sara', username: 'sara' }] },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...(values as Prisma.Sql[])).sql;
      const byProduct = /"productId" AS "productId"/.test(sql);
      if (sql.includes('analytics_grant_end'))
        return byProduct
          ? [{ productId: PRODUCT_A, renewed: 6, lapsed: 2, pending: 1, users: 9 }, { productId: PRODUCT_B, renewed: 1, lapsed: 1, pending: 0, users: 2 }]
          : [{ productId: null, renewed: 7, lapsed: 3, pending: 1, users: 11 }];
      if (sql.includes('analytics_signup_day'))
        return /GROUP BY n\."source"/.test(sql)
          ? [{ bucket: null, source: 'web', signups: 8, purchased7: 2, purchased30: 4 }, { bucket: null, source: 'telegram', signups: 2, purchased7: 1, purchased30: 1 }]
          : [{ bucket: '2026-09-01', source: null, signups: 7, purchased7: 2, purchased30: 3 }, { bucket: '2026-09-02', source: null, signups: 3, purchased7: 1, purchased30: 2 }];
      if (sql.includes('LIMIT')) return [{ userId: USER_1, currencyCode: 'USD', net: d('40.00'), orders: 2 }];
      if (sql.includes('analytics_user_day')) return [{ bucket: null, productId: null, panelId: null, buyers: 9, newBuyers: 4 }];
      return [];
    },
  };
}

const ctx = (how: { window?: number | null; hides?: boolean } = {}) =>
  contextOf(tx(how.window ?? null) as never, analyticsQuerySchema.parse({ from: '2026-09-01', to: '2026-09-02', compare: 'none' }), { operating: 'USD', hides: how.hides ?? false });

describe('renewalOf', () => {
  it('is renewed over renewed and lapsed — pending is beside the rate, never in it', () => {
    expect(renewalOf({ renewed: 6, lapsed: 2, pending: 5 })).toEqual({ rate: 0.75, renewed: 6, lapsed: 2, pending: 5 });
  });

  it('has no rate when nothing has renewed or lapsed yet', () => {
    expect(renewalOf({ renewed: 0, lapsed: 0, pending: 3 }).rate).toBeNull();
  });
});

describe('the renewal window setting', () => {
  it('takes a whole number of days from 1 to 30', () => {
    expect(analyticsSettingsSchema.safeParse({ renewalWindowDays: 1 }).success).toBe(true);
    expect(analyticsSettingsSchema.safeParse({ renewalWindowDays: 30 }).success).toBe(true);
    for (const days of [0, 31, 7.5, '7']) expect(analyticsSettingsSchema.safeParse({ renewalWindowDays: days }).success).toBe(false);
  });
});

describe('customersOf', () => {
  it('answers renewal over the window, by product, and the window it was judged by', async () => {
    const tab = await customersOf(ctx({ window: 14 }));
    expect(tab.renewalWindowDays).toBe(14);
    expect(tab.renewal).toEqual({ rate: 0.7, renewed: 7, lapsed: 3, pending: 1 });
    expect(tab.renewalByProduct[0]).toEqual({ productId: PRODUCT_A, rate: 0.75, renewed: 6, lapsed: 2, pending: 1 });
  });

  it('reads the default window for a tenant that set none', async () => {
    expect((await customersOf(ctx())).renewalWindowDays).toBe(RENEWAL_WINDOW_DEFAULT_DAYS);
  });

  it('answers signups, and how many bought within 7 and 30 days', async () => {
    const tab = await customersOf(ctx());
    expect(tab.signups.total).toBe(10);
    expect(tab.signups.purchased7).toEqual({ count: 3, rate: 0.3 });
    expect(tab.signups.purchased30).toEqual({ count: 5, rate: 0.5 });
    expect(tab.signups.series).toEqual([7, 3]);
    expect(tab.signups.bySource).toEqual([
      { source: 'web', signups: 8 },
      { source: 'telegram', signups: 2 },
    ]);
  });

  it('lists the top customers, named, to the tenant itself', async () => {
    expect((await customersOf(ctx())).topCustomers).toEqual([{ userId: USER_1, name: 'Sara', net: { USD: '40.00' }, orders: 2 }]);
  });

  it('never lists a person to the platform staff, and hides cells under 5 people', async () => {
    const tab = await customersOf(ctx({ hides: true }));
    expect(tab.topCustomers).toBeNull();
    // 3 signups is under 5; 7 alone would then be the whole, so it goes too.
    expect(tab.signups.series).toEqual([null, null]);
    expect(tab.signups.bySource).toEqual([{ source: 'telegram', people: 'fewer_than_5' }, { source: 'web', people: 'fewer_than_5' }]);
    expect(tab.renewalByProduct).toEqual([
      { productId: PRODUCT_A, people: 'fewer_than_5' },
      { productId: PRODUCT_B, people: 'fewer_than_5' },
    ]);
    // The whole tenant's figures are tier A and stay.
    expect(tab.signups.total).toBe(10);
    expect(tab.renewal.rate).toBe(0.7);
  });
});

describe('writeGrantEnds', () => {
  it('ends only a term whose end has passed: a Grant ending later today is still running', async () => {
    const written: unknown[][] = [];
    const tx = { $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => written.push(values) } as unknown as Prisma.TransactionClient;
    const today = { fromDay: '2026-10-17', toDay: '2026-10-17', zone: 'Asia/Tehran', ...dayBounds('2026-10-17', '2026-10-17', 'Asia/Tehran') };
    const now = new Date('2026-10-17T11:45:00Z');

    await writeGrantEnds(tx, today, { window: 7, today: '2026-10-17', now });

    // The cutoff bound into the INSERT is now, never the end of today (contract.analytics-tabs.md "Renewal" 1).
    const cutoffs = written[1].filter((v): v is Date => v instanceof Date);
    expect(cutoffs).toContainEqual(now);
    expect(cutoffs.every((v) => v.getTime() <= today.to.getTime())).toBe(true);
  });
});
