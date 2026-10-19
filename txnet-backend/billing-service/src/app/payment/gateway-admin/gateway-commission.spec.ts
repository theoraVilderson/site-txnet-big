/**
 * Gateway commission as cost (F-1001-v, billing/contract.analytics-expenses.md
 * "Gateway commission").
 *
 * The ways this goes wrong quietly:
 *
 *  - **a fee counted twice.** The payer already covered `feeApplied`; the cost
 *    is only what the provider took beyond it — and a fee above the
 *    commission is a gain, never dropped as 0;
 *  - **the percent on the wrong base.** The provider takes its cut of what was
 *    charged — after the coupon, with the fee and tax on top — not of what was
 *    credited;
 *  - **a fixed amount in the wrong currency.** It is the gateway's; summed into
 *    the payment currency's row it would be a number in two units;
 *  - **another tenant's gateway.** The platform owner manages every gateway,
 *    but a reseller's commission is the reseller's economics: only a gateway
 *    the caller owns carries one, and the rest read as not found;
 *  - **a correction that edits history.** A change is a new row from its day;
 *    the body names no row to change.
 */
import { Prisma } from '@prisma/client';

import { gatewayCommissionCosts, type CommissionedPayment } from '../../analytics/analytics-cost';
import { commissionSchema, ownGatewayOnly } from './gateway-commission';

const d = (v: string) => new Prisma.Decimal(v);

const payment = (over: Partial<CommissionedPayment> = {}): CommissionedPayment => ({
  day: '2026-10-19',
  currencyCode: 'USD',
  credited: d('100'),
  discount: d('0'),
  fee: d('0'),
  tax: d('0'),
  percent: d('1'),
  fixedAmount: d('0'),
  fixedCurrencyCode: 'USD',
  ...over,
});

const costs = (rows: CommissionedPayment[]) => gatewayCommissionCosts(rows).map((r) => [r.day, r.currencyCode, r.cost.toFixed(6)]);

describe('gatewayCommissionCosts', () => {
  it('costs the percent of what was charged — after the coupon, fee and tax on top — less the fee the payer covered', () => {
    // Charged 100 - 10 + 2 + 8 = 100; 3% of it is 3; the payer covered 2.
    expect(costs([payment({ discount: d('10'), fee: d('2'), tax: d('8'), percent: d('3') })])).toEqual([['2026-10-19', 'USD', '1.000000']]);
  });

  it('keeps a fee above the commission as a gain', () => {
    expect(costs([payment({ fee: d('5'), percent: d('1') })])).toEqual([['2026-10-19', 'USD', '-3.950000']]);
  });

  it("puts the fixed amount in the gateway's currency, apart from the percent's", () => {
    const rows = costs([payment({ currencyCode: 'IRT', credited: d('1000000'), percent: d('0'), fixedAmount: d('0.5'), fixedCurrencyCode: 'USD' })]);
    expect(rows.sort()).toEqual([
      ['2026-10-19', 'IRT', '0.000000'],
      ['2026-10-19', 'USD', '0.500000'],
    ]);
  });

  it('sums the payments of one day and currency into one row with no product, panel or user', () => {
    const rows = gatewayCommissionCosts([payment(), payment({ credited: d('50') }), payment({ day: '2026-10-20' })]);
    expect(rows.map((r) => [r.day, r.cost.toFixed(2)]).sort()).toEqual([
      ['2026-10-19', '1.50'],
      ['2026-10-20', '1.00'],
    ]);
    expect(rows.every((r) => r.kind === 'gateway' && r.productId === null && r.panelId === null && r.userId === null)).toBe(true);
  });
});

describe('the commission body', () => {
  const body = { percent: '1.5', fixedAmount: '0', effectiveFrom: '2026-10-01' };

  it('takes a percent 0..100 at four places, a fixed amount at or above zero, and a day', () => {
    expect(commissionSchema.parse(body)).toEqual(body);
    expect(commissionSchema.parse({ ...body, percent: '100', fixedAmount: '1000.25' })).toBeTruthy();
  });

  it('refuses a float, a percent past 100 or finer than four places, a negative amount, and a row to change', () => {
    expect(commissionSchema.safeParse({ ...body, percent: 1.5 }).success).toBe(false);
    expect(commissionSchema.safeParse({ ...body, percent: '100.01' }).success).toBe(false);
    expect(commissionSchema.safeParse({ ...body, percent: '1.23456' }).success).toBe(false);
    expect(commissionSchema.safeParse({ ...body, fixedAmount: '-1' }).success).toBe(false);
    expect(commissionSchema.safeParse({ ...body, id: '00000000-0000-0000-0000-000000000000' }).success).toBe(false);
  });
});

describe('ownGatewayOnly', () => {
  const OWN = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';

  it("answers the owning tenant: the platform owner's for a platform gateway, the row's for a tenant gateway that is the caller's", () => {
    expect(ownGatewayOnly({ source: 'platform', id: 'g' }, null, { tenantId: OWN, owner: true })).toBe(OWN);
    expect(ownGatewayOnly({ source: 'tenant', id: 'g' }, { tenantId: OWN }, { tenantId: OWN, owner: false })).toBe(OWN);
  });

  it("refuses a platform gateway to anyone else, and a reseller's gateway even to the platform owner", () => {
    expect(() => ownGatewayOnly({ source: 'platform', id: 'g' }, null, { tenantId: OTHER, owner: false })).toThrow('gateway_not_found');
    expect(() => ownGatewayOnly({ source: 'tenant', id: 'g' }, { tenantId: OTHER }, { tenantId: OWN, owner: true })).toThrow('gateway_not_found');
    expect(() => ownGatewayOnly({ source: 'tenant', id: 'g' }, null, { tenantId: OWN, owner: false })).toThrow('gateway_not_found');
  });
});
