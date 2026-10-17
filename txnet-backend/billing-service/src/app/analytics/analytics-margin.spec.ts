/**
 * Margin (F-1001-l, billing/contract.analytics-tabs.md "Margin").
 *
 * The ways this goes wrong quietly:
 *
 *  - **dollars subtracted from tomans.** A platform panel costs USD and sells
 *    in the tenant's currency; a cost is converted at **its own day's** rate
 *    (ADR-0149), the toman as the rial over ten — never today's rate for last
 *    month, never two currencies added;
 *  - **a cost in today's currency for last month's sales** (F-1001-q). A
 *    tenant that changed currency sold each day in the money it had then;
 *    a day's cost converts into that, never into the currency of the pass;
 *  - **a refund's cost in another currency than its refund.** The cost a
 *    refund takes back is in the money of the sale it undoes, as its net is;
 *  - **a cost with no rate read as free.** No rate on record keeps the cost in
 *    its own currency, so the margin shows it apart instead of a 0;
 *  - **a margin % from nothing.** Margin ÷ net with no net is no figure, not
 *    infinity and not -100%;
 *  - **a loss not flagged.** A row whose operating-currency margin is below 0
 *    says so; one with no cost at all is not a loss;
 *  - **no cost read as 100% margin** (ADR-0151 (5)). A row that sold with no
 *    cost row at all is `noCost`; one costed at 0 is a cost, and is not.
 */
import { Prisma } from '@prisma/client';

import type { CostDayRow } from './analytics-cost';
import { convertCosts, currencyOnDay, rateLookup } from './analytics-fx';
import { marginCellsOf } from './analytics-margin-cells';

const d = (v: string) => new Prisma.Decimal(v);
const cost = (day: string, usd: string, currencyCode = 'USD'): CostDayRow => ({
  day,
  kind: 'panel',
  panelId: null,
  servedTenantId: null,
  productId: null,
  userId: null,
  currencyCode,
  cost: d(usd),
  bytes: BigInt(1),
});

describe('convertCosts', () => {
  const rates = rateLookup([
    { code: 'IRR', day: '2026-09-10', rate: d('600000') },
    { code: 'IRR', day: '2026-09-11', rate: d('700000') },
  ]);

  it("converts each day at that day's rate, the toman as the rial over ten", () => {
    const rows = convertCosts([cost('2026-09-10', '1.5'), cost('2026-09-11', '1.5')], () => 'IRT', rates);
    expect(rows.map((r) => [r.saleCurrencyCode, r.saleCost?.toFixed(2)])).toEqual([
      ['IRT', '90000.00'],
      ['IRT', '105000.00'],
    ]);
  });

  it('leaves a cost already in the operating currency as it is, and one with no rate unconverted', () => {
    const [same, none] = convertCosts([cost('2026-09-10', '2.25', 'IRT'), cost('2026-09-10', '3', 'EUR')], () => 'IRT', rates);
    expect(same.saleCost?.toFixed(6)).toBe('2.250000');
    expect(none).toMatchObject({ saleCurrencyCode: 'IRT', saleCost: null });
  });

  it('converts into the pivot without a rate of its own', () => {
    expect(convertCosts([cost('2026-09-10', '60000', 'IRT')], () => 'USD', rates)[0].saleCost?.toFixed(2)).toBe('1.00');
  });

  it('converts each day into the currency the tenant sold in that day, not the one it has now (F-1001-q)', () => {
    const soldIn = currencyOnDay('USD', [{ day: '2026-09-11', fromCode: 'IRT' }]);
    const rows = convertCosts([cost('2026-09-10', '1.5'), cost('2026-09-11', '1.5')], soldIn, rates);
    expect(rows.map((r) => [r.saleCurrencyCode, r.saleCost?.toFixed(2)])).toEqual([
      ['IRT', '90000.00'],
      ['USD', '1.50'],
    ]);
  });

  it("converts a sale's cost, and its refund's, into the currency that sale was made in — a refund paid back after a change too", () => {
    const refund = { ...cost('2026-09-11', '-4'), kind: 'sale' as const, soldIn: 'USD' };
    const [row] = convertCosts([refund], () => 'IRT', rates);
    expect([row.saleCurrencyCode, row.saleCost?.toFixed(2)]).toEqual(['USD', '-4.00']);
  });
});

describe('currencyOnDay', () => {
  const soldIn = currencyOnDay('EUR', [
    { day: '2026-09-05', fromCode: 'IRT' },
    { day: '2026-09-05', fromCode: 'USD' },
    { day: '2026-09-20', fromCode: 'GBP' },
  ]);

  it("answers the currency in force at a day's end: the first later change's old one, else today's", () => {
    expect(['2026-09-04', '2026-09-05', '2026-09-19', '2026-09-20'].map(soldIn)).toEqual(['IRT', 'GBP', 'GBP', 'EUR']);
  });

  it('is the operating currency for every day of a tenant that never changed', () => {
    expect(currencyOnDay('IRT', [])('2020-01-01')).toBe('IRT');
  });
});

describe('marginCellsOf', () => {
  const how = { currencies: ['IRT'], operating: 'IRT' };

  it('is net minus cost per currency, the rate of the operating one, a loss flagged', () => {
    const [cell] = marginCellsOf([{ key: 'p', currencyCode: 'IRT', amount: d('100') }], [{ key: 'p', currencyCode: 'IRT', amount: d('130') }], how);
    expect(cell).toEqual({ id: 'p', net: { IRT: '100.00' }, cost: { IRT: '130.00' }, margin: { IRT: '-30.00' }, marginRate: -0.3, loss: true, noCost: false });
  });

  it('answers no rate where nothing was sold, and an uncosted row is no loss', () => {
    const cells = marginCellsOf(
      [{ key: 'sold', currencyCode: 'IRT', amount: d('50') }],
      [{ key: 'free', currencyCode: 'IRT', amount: d('5') }],
      how,
    );
    expect(cells.find((c) => c.id === 'free')).toMatchObject({ marginRate: null, loss: true, margin: { IRT: '-5.00' } });
    expect(cells.find((c) => c.id === 'sold')).toMatchObject({ marginRate: 1, loss: false, cost: { IRT: '0.00' } });
  });

  it('keeps an unconverted cost in its own currency beside the sale, never summed into it', () => {
    const [cell] = marginCellsOf([{ key: null, currencyCode: 'IRT', amount: d('10') }], [{ key: null, currencyCode: 'USD', amount: d('1') }], {
      currencies: ['IRT', 'USD'],
      operating: 'IRT',
    });
    expect(cell).toMatchObject({ margin: { IRT: '10.00', USD: '-1.00' }, marginRate: 1, loss: false });
  });

  it('lists the largest net first, then the deepest loss', () => {
    const cells = marginCellsOf(
      [
        { key: 'a', currencyCode: 'IRT', amount: d('10') },
        { key: 'b', currencyCode: 'IRT', amount: d('20') },
      ],
      [
        { key: 'c', currencyCode: 'IRT', amount: d('1') },
        { key: 'd', currencyCode: 'IRT', amount: d('9') },
      ],
      how,
    );
    expect(cells.map((c) => c.id)).toEqual(['b', 'a', 'd', 'c']);
  });
});

describe('marginCellsOf, a row with no cost', () => {
  const how = { currencies: ['USD'], operating: 'USD' };
  const money = (key: string, amount: string) => ({ key, currencyCode: 'USD', amount: d(amount) });

  it('is noCost when it sold and no cost row names it; a cost of 0 is a cost', () => {
    const cells = marginCellsOf([money('api', '50'), money('ip', '20'), money('vpn', '10')], [money('ip', '0'), money('vpn', '4')], how);
    expect(cells.map((c) => [c.id, c.noCost, c.marginRate])).toEqual([
      ['api', true, 1],
      ['ip', false, 1],
      ['vpn', false, 0.6],
    ]);
  });
});
