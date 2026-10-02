import { Prisma } from '@prisma/client';

import { candidatesFor, type CandidateInputs, type DecisionPrediction, type OfferOption, type PlanOption } from './candidates';
import { deliveryItem } from './delivery';
import { matchOutcome } from './outcome';

/**
 * F-038-f2 / ADR-0110 point 3, ADR-0109 point 9: `retain_offer` — a renewal
 * the user is unlikely to make without a discount (`renewal_probability`
 * under 0.5) is suggested with one of the tenant's own offers instead of
 * `renew`, still one suggestion per Grant; each offer once per account.
 *
 * The failures worth a spec: a discount handed to someone who would have
 * renewed anyway; the same offer twice to one account; a discount bigger
 * than either the offer's cap or the template's own; an offer priced in
 * another currency than the plan (the engine converts nothing); the dearer
 * of two offers picked; a resize displaced by a discount.
 */

const GRANT = '00000000-0000-4000-8000-0000000000f1';
const NOW = new Date('2026-10-05T09:20:00Z');
const DAY = 86_400_000;
const D = (v: string) => new Prisma.Decimal(v);

const plan = (variantId: string, price: string, size = 50, currencyCode = 'IRR'): PlanOption => ({
  variantId,
  productId: 'p1',
  billingMode: 'prepaid',
  durationDays: 30,
  size: BigInt(size) * BigInt(1024 ** 3),
  price: { amount: D(price), currencyCode },
});

const renewal = (value: number): DecisionPrediction => ({
  id: 'pr-renew', kind: 'renewal_probability', value, predictedAt: null, confidence: 0.7,
  reasons: [{ code: 'rule_defaults', grantId: GRANT }],
});

const variantOffer = (over: Partial<OfferOption> = {}): OfferOption => ({
  id: 'of-variant', variantId: 'v50', template: null, maxDiscountPercent: D('20'), currencyCode: 'IRR', ...over,
});
const templateOffer = (template: OfferOption['template'], over: Partial<OfferOption> = {}): OfferOption => ({
  id: 'of-template', variantId: null, template, maxDiscountPercent: D('20'), currencyCode: 'IRR', ...over,
});
const percentTemplate = (value: string, cap: string | null = null) => ({ discountType: 'percentage' as const, discountValue: D(value), maxDiscountCap: cap === null ? null : D(cap), currencyCode: 'IRR' });
const fixedTemplate = (value: string, currencyCode = 'IRR') => ({ discountType: 'fixed_amount' as const, discountValue: D(value), maxDiscountCap: null, currencyCode });

function inputs(predictions: DecisionPrediction[], offers: OfferOption[], over: Partial<CandidateInputs> = {}): CandidateInputs {
  return {
    predictions,
    grants: new Map([[GRANT, { id: GRANT, variantId: 'v50', endsAt: new Date(NOW.getTime() + 5 * DAY) }]]),
    plans: new Map([['v50', plan('v50', '200000')]]),
    offers,
    usedOfferIds: new Set(),
    ...over,
  };
}

const only = (input: CandidateInputs) => {
  const out = candidatesFor(input, NOW);
  expect(out).toHaveLength(1);
  return out[0];
};
const offerReason = (c: ReturnType<typeof only>) => c.reasons.find((r) => (r as { code: string }).code === 'suggest_offer');

describe('retain_offer candidates (F-038-f2)', () => {
  it('takes the place of the renewal when it is unlikely without a discount: the offer, its discount and the margin after it', () => {
    const c = only(inputs([renewal(0.4)], [variantOffer()]));
    expect(c).toMatchObject({
      actionType: 'retain_offer',
      offerId: 'of-variant',
      predictionId: 'pr-renew',
      confidence: 0.7,
      templateKey: 'suggestion.retain_offer',
      targetVariantId: 'v50',
      // 0.4 × (200000 − 20 %) — the discount is the seller's, so it comes off the margin.
      expectedMargin: { amount: '64000.00', currencyCode: 'IRR' },
    });
    expect(offerReason(c)).toEqual({ code: 'suggest_offer', grantId: GRANT, offerId: 'of-variant', discountPercent: '20.00', discount: '40000.00', currencyCode: 'IRR' });
  });

  it('gives nothing to a renewal at 0.5 or above: that user is told `renew`', () => {
    expect(only(inputs([renewal(0.5)], [variantOffer()])).actionType).toBe('renew');
    expect(only(inputs([renewal(0.8)], [variantOffer()])).offerId).toBeUndefined();
  });

  it('gives each offer once per account: an offer already used for them is skipped, the next one tried', () => {
    const used = new Set(['of-variant']);
    expect(only(inputs([renewal(0.3)], [variantOffer()], { usedOfferIds: used })).actionType).toBe('renew');
    const next = only(inputs([renewal(0.3)], [variantOffer(), templateOffer(percentTemplate('10'))], { usedOfferIds: used }));
    expect(next).toMatchObject({ actionType: 'retain_offer', offerId: 'of-template' });
  });

  it('of two offers, picks the smaller discount — the higher margin', () => {
    const c = only(inputs([renewal(0.3)], [variantOffer({ maxDiscountPercent: D('25') }), templateOffer(percentTemplate('15'))]));
    expect(c.offerId).toBe('of-template');
    expect(offerReason(c)).toMatchObject({ discountPercent: '15.00', discount: '30000.00' });
  });

  it('never gives more than the offer\'s cap or the template\'s own discount', () => {
    expect(offerReason(only(inputs([renewal(0.3)], [templateOffer(percentTemplate('30'))])))).toMatchObject({ discountPercent: '20.00', discount: '40000.00' });
    // A percentage template's own cap in money holds too.
    expect(offerReason(only(inputs([renewal(0.3)], [templateOffer(percentTemplate('20', '25000'))])))).toMatchObject({ discountPercent: '12.50', discount: '25000.00' });
    // A fixed amount is its share of the price.
    expect(offerReason(only(inputs([renewal(0.3)], [templateOffer(fixedTemplate('30000'))])))).toMatchObject({ discountPercent: '15.00', discount: '30000.00' });
  });

  it('offers nothing it cannot price: another currency than the plan, or another plan than the Grant\'s', () => {
    expect(only(inputs([renewal(0.3)], [templateOffer(fixedTemplate('10', 'USD'))])).actionType).toBe('renew');
    expect(only(inputs([renewal(0.3)], [variantOffer({ currencyCode: 'USD' })])).actionType).toBe('renew');
    expect(only(inputs([renewal(0.3)], [variantOffer({ variantId: 'v-other' })])).actionType).toBe('renew');
  });

  it('never displaces a resize, and takes the place of a top-up', () => {
    const sizeUp: DecisionPrediction = {
      id: 'pr-size', kind: 'right_size', value: 1.8, predictedAt: null, confidence: 0.8,
      reasons: [{ code: 'size_up', grantId: GRANT }],
    };
    const resized = only(inputs([renewal(0.3), sizeUp], [variantOffer()], { plans: new Map([['v50', plan('v50', '200000')], ['v100', plan('v100', '350000', 100)]]) }));
    expect(resized.actionType).toBe('resize_up');

    const wallet: DecisionPrediction = {
      id: 'pr-wallet', kind: 'wallet_need', value: 400000, amount: '400000.00', currencyCode: 'IRR', predictedAt: null, confidence: 0.7,
      reasons: [{ code: 'next_two_renewals', grantId: GRANT }],
    };
    expect(only(inputs([renewal(0.3), wallet], [variantOffer()])).actionType).toBe('retain_offer');
  });
});

describe('retain_offer delivery and outcome (F-038-f2)', () => {
  const reasons = [
    { code: 'suggest_variant', grantId: GRANT, fromVariantId: 'v50', variantId: 'v50', price: '200000.00', currencyCode: 'IRR' },
    { code: 'suggest_offer', grantId: GRANT, offerId: 'of-variant', discountPercent: '20.00', discount: '40000.00', currencyCode: 'IRR' },
  ];

  it('hands delivery the offer and its discount, for billing to issue the coupon (F-038-f3)', () => {
    const row = {
      id: 'a1', tenantId: 't1', subjectKind: 'user' as const, subjectId: 'u1', actionType: 'retain_offer' as const, status: 'scheduled' as const,
      templateKey: 'suggestion.retain_offer', renderedBy: 'template' as const, renderedText: null, deadline: new Date(NOW.getTime() + 5 * DAY), reasons,
    };
    expect(deliveryItem(row)).toMatchObject({
      grantId: GRANT,
      variantId: 'v50',
      offer: { offerId: 'of-variant', discountPercent: '20.00', discount: { amount: '40000.00', currencyCode: 'IRR' } },
    });
  });

  it('converts as a renewal does: a paid invoice for the plan, or the user renewing the Grant', () => {
    const action = { actionType: 'retain_offer', subjectId: 'u1', createdAt: NOW, sentAt: NOW, reasons };
    const at = new Date(NOW.getTime() + 2 * DAY);
    expect(matchOutcome(action, [{ kind: 'purchase', ref: 'inv', userId: 'u1', at, variantId: 'v50', grantId: null, amount: '160000.00', currencyCode: 'IRR' }])?.amount).toBe('160000.00');
    expect(matchOutcome(action, [{ kind: 'renewal', ref: 'ren', userId: 'u1', at, variantId: null, grantId: GRANT, amount: null, currencyCode: null }])).not.toBeNull();
  });
});
