import { Prisma } from '@prisma/client';

import { candidatesFor, type CandidateInputs, type DecisionPrediction, type OfferOption, type PlanOption, type SeasonWindow } from './candidates';
import { scheduleAt } from './schedule';

/**
 * F-038-r (ADR-0109 point 15: seasons come from F-505-a, not a second
 * calendar). A season's written campaign on the plan a suggestion names moves
 * the suggestion into the season's window, and takes the place of a discount
 * coupon: the season already lowers the price, so the tenant's offer budget is
 * not spent on top of it.
 *
 * The failures worth a spec: a pitch sent the day before Nowruz at the full
 * price; a coupon stacked on a season price; a season in another currency, or
 * dearer than today's price, or after the deadline, steering anything; a
 * season window with no free slot leaving the suggestion unsent.
 */

const GRANT = '00000000-0000-4000-8000-0000000000f1';
const NOW = new Date('2026-10-05T09:20:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D = (v: string) => new Prisma.Decimal(v);
const at = (ms: number) => new Date(NOW.getTime() + ms);

const plan: PlanOption = { variantId: 'v50', productId: 'p1', billingMode: 'prepaid', durationDays: 30, size: BigInt(50) * BigInt(1024 ** 3), price: { amount: D('200000'), currencyCode: 'IRR' } };
const renewal = (value: number): DecisionPrediction => ({ id: 'pr-renew', kind: 'renewal_probability', value, predictedAt: null, confidence: 0.7, reasons: [{ code: 'rule_defaults', grantId: GRANT }] });
const offer: OfferOption = { id: 'of-1', variantId: 'v50', template: null, maxDiscountPercent: D('20'), currencyCode: 'IRR', places: 0 };
const thursday = (over: Partial<SeasonWindow> = {}): SeasonWindow => ({
  seasonId: 'se-1', name: 'Thursday night', variantId: 'v50', amount: D('150000'), currencyCode: 'IRR', startsAt: at(2 * DAY), endsAt: at(2 * DAY + 12 * HOUR), ...over,
});

function inputs(over: Partial<CandidateInputs> = {}): CandidateInputs {
  return {
    predictions: [renewal(0.8)],
    grants: new Map([[GRANT, { id: GRANT, variantId: 'v50', endsAt: at(5 * DAY) }]]),
    plans: new Map([['v50', plan]]),
    offers: [],
    usedOfferIds: new Set(),
    ...over,
  };
}
const seasonReason = (c: { reasons: unknown[] }) => c.reasons.find((r) => (r as { code: string }).code === 'season');

describe('a season on the plan (F-038-r)', () => {
  it('moves the renewal into the season window and weighs it at the season price', () => {
    const [c] = candidatesFor(inputs({ seasons: [thursday()] }), NOW);
    expect(c).toMatchObject({ actionType: 'renew', deadline: at(5 * DAY), notBefore: at(2 * DAY), seasonEnd: at(2 * DAY + 12 * HOUR) });
    // 0.8 × 150000: the price the user will pay in the window.
    expect(c.expectedMargin).toEqual({ amount: '120000.00', currencyCode: 'IRR' });
    expect(seasonReason(c)).toEqual({ code: 'season', seasonId: 'se-1', name: 'Thursday night', price: '150000.00', currencyCode: 'IRR', startsAt: at(2 * DAY).toISOString(), endsAt: at(2 * DAY + 12 * HOUR).toISOString() });
  });

  it('takes the place of a discount coupon: renew in the season, the offer budget kept', () => {
    const [c] = candidatesFor(inputs({ predictions: [renewal(0.4)], offers: [offer], seasons: [thursday()] }), NOW);
    expect(c.actionType).toBe('renew');
    expect(c.offerId).toBeUndefined();
    expect(seasonReason(c)).toBeDefined();
  });

  it('changes nothing in another currency, dearer than today, or starting after the deadline', () => {
    for (const s of [thursday({ currencyCode: 'USD' }), thursday({ amount: D('250000') }), thursday({ startsAt: at(6 * DAY), endsAt: at(7 * DAY) }), thursday({ variantId: 'v100' })]) {
      const [c] = candidatesFor(inputs({ predictions: [renewal(0.4)], offers: [offer], seasons: [s] }), NOW);
      expect(c.actionType).toBe('retain_offer');
      expect(c.notBefore).toBeUndefined();
      expect(seasonReason(c)).toBeUndefined();
    }
  });
});

describe('scheduleAt inside a season window', () => {
  const quietNever = null;
  it('the first free slot from the season\'s start, before its end', () => {
    expect(scheduleAt({ activeHours: new Array(168).fill(0), quiet: quietNever, deadline: at(5 * DAY), notBefore: at(2 * DAY), seasonEnd: at(2 * DAY + 12 * HOUR), now: NOW })).toEqual(at(2 * DAY));
  });

  it('none when the window is past or empty — the caller falls back to the ordinary slot', () => {
    expect(scheduleAt({ activeHours: new Array(168).fill(0), quiet: quietNever, deadline: at(DAY), notBefore: at(2 * DAY), seasonEnd: at(3 * DAY), now: NOW })).toBeNull();
  });
});
