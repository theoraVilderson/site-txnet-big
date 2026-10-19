/**
 * General expenses (F-1001-t, billing/contract.analytics-expenses.md).
 *
 * The ways this goes wrong quietly:
 *
 *  - **a spread that loses or invents money.** A year's domain spread over its
 *    days rounds each day; the days must still sum to what was paid, exactly;
 *  - **a month that is not a month.** Bought on 31 January for one month runs
 *    to the end of February, never into March;
 *  - **two expenses on one day as two rows of one cell.** The cost grain is
 *    unique: they are summed, in their own currency each;
 *  - **another tenant's ledger.** The platform's staff may read a reseller's
 *    figures, never its expenses: the ledger is its own tenant's only;
 *  - **a correction that edits history.** Nothing is changed in place; a take
 *    back is its own row, and the body that adds names no take back.
 */
import { Prisma } from '@prisma/client';

import { spreadExpenses } from './analytics-cost';
import { addMonths } from './analytics-days';
import { expenseSchema, ownLedgerOnly } from './analytics-expense';

const d = (v: string) => new Prisma.Decimal(v);
const sum = (rows: { cost: Prisma.Decimal }[]) => rows.reduce((s, r) => s.plus(r.cost), d('0'));
const whole = { from: '2000-01-01', to: '2100-01-01' };

describe('addMonths', () => {
  it('is the same day of a later month, clamped to its last day', () => {
    expect(addMonths('2026-10-19', 1)).toBe('2026-11-19');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
  });
});

describe('spreadExpenses', () => {
  it("spreads an expense over its months' days as overhead, summing to what was paid", () => {
    const rows = spreadExpenses([{ spentOn: '2026-10-19', months: 1, amount: d('100'), currencyCode: 'USD' }], whole);
    expect(rows).toHaveLength(31);
    expect(rows[0].day).toBe('2026-10-19');
    expect(rows[30].day).toBe('2026-11-18');
    expect(sum(rows).toFixed()).toBe('100');
    expect(rows.every((r) => r.kind === 'overhead' && r.productId === null && r.panelId === null && r.userId === null)).toBe(true);
  });

  it('keeps a month bought on the 31st inside the next month', () => {
    const rows = spreadExpenses([{ spentOn: '2026-01-31', months: 1, amount: d('28'), currencyCode: 'USD' }], whole);
    expect(rows.map((r) => r.day)).toEqual(Array.from({ length: 28 }, (_, i) => (i === 0 ? '2026-01-31' : `2026-02-${String(i).padStart(2, '0')}`)));
    expect(rows.every((r) => r.cost.eq(1))).toBe(true);
  });

  it('answers only the days of the window', () => {
    const rows = spreadExpenses([{ spentOn: '2026-10-01', months: 12, amount: d('365'), currencyCode: 'USD' }], { from: '2026-10-10', to: '2026-10-11' });
    expect(rows.map((r) => r.day)).toEqual(['2026-10-10', '2026-10-11']);
    expect(rows.every((r) => r.cost.eq(1))).toBe(true);
  });

  it('sums two expenses of one day and currency into one row, each currency apart', () => {
    const rows = spreadExpenses(
      [
        { spentOn: '2026-10-19', months: 1, amount: d('31'), currencyCode: 'USD' },
        { spentOn: '2026-10-19', months: 1, amount: d('62'), currencyCode: 'USD' },
        { spentOn: '2026-10-19', months: 1, amount: d('310000'), currencyCode: 'IRT' },
      ],
      { from: '2026-10-19', to: '2026-10-19' },
    );
    expect(rows.map((r) => [r.currencyCode, r.cost.toFixed()]).sort()).toEqual([
      ['IRT', '10000'],
      ['USD', '3'],
    ]);
  });
});

describe('the expense body', () => {
  const body = { category: 'equipment', amount: '1200', currencyCode: 'USD', spentOn: '2026-10-19', months: 12 };

  it('takes a category, a money string, a registered-looking currency, a day and 1..60 months', () => {
    expect(expenseSchema.parse(body)).toEqual(body);
    expect(expenseSchema.parse({ ...body, months: undefined }).months).toBe(1);
  });

  it('refuses a float, a zero, a month count out of range, an unknown category and a take back in the same body', () => {
    expect(expenseSchema.safeParse({ ...body, amount: 1200 }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...body, amount: '0' }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...body, months: 61 }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...body, category: 'coffee' }).success).toBe(false);
    expect(expenseSchema.safeParse({ ...body, takesBackId: '00000000-0000-0000-0000-000000000000' }).success).toBe(false);
  });
});

describe('ownLedgerOnly', () => {
  it("admits the tenant's owner and members — the owner signs in on the platform's tenant — and the platform's staff on its own", () => {
    expect(() => ownLedgerOnly({ as: 'owner' })).not.toThrow();
    expect(() => ownLedgerOnly({ as: 'member' })).not.toThrow();
    expect(() => ownLedgerOnly({ as: 'staff', platform: true })).not.toThrow();
  });

  it("refuses the platform's staff on a reseller, whom the figures door lets in", () => {
    expect(() => ownLedgerOnly({ as: 'staff' })).toThrow('not_allowed');
  });
});
