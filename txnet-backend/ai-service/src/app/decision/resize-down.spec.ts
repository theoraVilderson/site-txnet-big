import { Prisma } from '@prisma/client';

import { candidatesFor, RESIZE_DOWN_HEADROOM, SUGGEST_LEAD_DAYS, type CandidateInputs, type DecisionPrediction, type PlanOption } from './candidates';

/**
 * F-1514 / ADR-0109 point 7: an account that used under 40 % of its plan in
 * each of its last two periods is offered a smaller one at renewal — "the most
 * counterintuitive and effective move": a buyer who notices they overpay
 * leaves; one told so by the seller stays.
 *
 * The failures worth a spec: a plan too small for what they actually use
 * (they run out and blame the seller); a "smaller" plan that is not smaller,
 * or of another product; the pitch weeks before renewal, when it can only
 * read as a refund nobody gives; and a Grant offered both its own plan and a
 * smaller one.
 */

const GIB = BigInt(1024 ** 3);
const GRANT = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-10-05T09:20:00Z');
const DAY = 86_400_000;

const plan = (variantId: string, gib: number, price: number, productId = 'p1'): PlanOption => ({
  variantId,
  productId,
  billingMode: 'prepaid',
  durationDays: 30,
  size: BigInt(gib) * GIB,
  price: { amount: new Prisma.Decimal(price), currencyCode: 'IRR' },
});

const renewal: DecisionPrediction = {
  id: 'pr-renew', kind: 'renewal_probability', value: 0.6, predictedAt: null, confidence: 0.7,
  reasons: [{ code: 'rule_defaults', grantId: GRANT }],
};
const sizeDown = (share: number): DecisionPrediction => ({
  id: 'pr-size', kind: 'right_size', value: share, predictedAt: null, confidence: 0.7,
  reasons: [{ code: 'size_down', grantId: GRANT, periods: 2, under: 0.4 }],
});

function inputs(share: number, over: Partial<CandidateInputs> = {}, endsInDays = 3): CandidateInputs {
  return {
    predictions: [renewal, sizeDown(share)],
    grants: new Map([[GRANT, { id: GRANT, variantId: 'v100', endsAt: new Date(NOW.getTime() + endsInDays * DAY) }]]),
    plans: new Map([
      ['v10', plan('v10', 10, 60_000)],
      ['v20', plan('v20', 20, 100_000)],
      ['v50', plan('v50', 50, 200_000)],
      ['v100', plan('v100', 100, 350_000)],
    ]),
    ...over,
  };
}

describe('resize_down candidates (F-1514)', () => {
  it('offers the smallest plan that still holds what they used, with headroom, instead of the same plan', () => {
    // Used at most 30 % of 100 GiB = 30 GiB; with headroom 37.5 GiB → 50 GiB, not 20.
    const out = candidatesFor(inputs(0.3), NOW);
    expect(RESIZE_DOWN_HEADROOM).toBe(1.25);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ actionType: 'resize_down', targetVariantId: 'v50', predictionId: 'pr-size', templateKey: 'suggestion.resize_down' });
    expect(out[0].reasons[0]).toMatchObject({ code: 'suggest_variant', fromVariantId: 'v100', variantId: 'v50' });
  });

  it('goes as small as the use allows', () => {
    // 10 % of 100 GiB = 10 GiB → 12.5 with headroom → 20 GiB.
    expect(candidatesFor(inputs(0.1), NOW)[0]).toMatchObject({ actionType: 'resize_down', targetVariantId: 'v20' });
  });

  it('with no smaller plan that fits, offers the same plan again', () => {
    const plans = new Map([['v100', plan('v100', 100, 350_000)], ['v20', plan('v20', 20, 100_000)]]);
    // 35 % → 43.75 GiB needed: 20 is too small, nothing between.
    expect(candidatesFor(inputs(0.35, { plans }), NOW).map((c) => [c.actionType, c.targetVariantId])).toEqual([['renew', 'v100']]);
  });

  it('never offers another product’s plan', () => {
    const plans = new Map([['v100', plan('v100', 100, 350_000)], ['x50', plan('x50', 50, 150_000, 'p2')]]);
    expect(candidatesFor(inputs(0.3, { plans }), NOW)[0]).toMatchObject({ actionType: 'renew', targetVariantId: 'v100' });
  });

  it('waits for the renewal: nothing earlier than the lead time before the Grant ends', () => {
    expect(candidatesFor(inputs(0.3, {}, SUGGEST_LEAD_DAYS + 1), NOW)).toEqual([]);
  });
});
