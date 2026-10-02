import { Prisma } from '@prisma/client';

import { candidatesFor, type CandidateInputs, type DecisionPrediction, type PlanOption } from './candidates';
import { deliveryItem } from './delivery';

/**
 * F-038-k / ADR-0109 point 7: `top_up_wallet` — the next two renewals' cost
 * minus what the wallet has, rounded up to a deposit preset (the `wallet_need`
 * prediction, F-038-d). User 2026-10-02: one suggestion per Grant — when the
 * wallet is short, the top-up takes the place of the renewal, as a resize does.
 *
 * The failures worth a spec: two pitches about one Grant; a top-up told while
 * the Grant is weeks from its end; an amount carried as a float (C-02) or in
 * another currency than the plan it funds; a resize displaced by a top-up.
 */

const GRANT = '00000000-0000-4000-8000-0000000000c1';
const NOW = new Date('2026-10-05T09:20:00Z');
const DAY = 86_400_000;

const plan = (variantId: string, price: string, currencyCode = 'IRR'): PlanOption => ({
  variantId,
  productId: 'p1',
  billingMode: 'prepaid',
  durationDays: 30,
  size: BigInt(50) * BigInt(1024 ** 3),
  price: { amount: new Prisma.Decimal(price), currencyCode },
});

const renewal: DecisionPrediction = {
  id: 'pr-renew', kind: 'renewal_probability', value: 0.6, predictedAt: null, confidence: 0.7,
  reasons: [{ code: 'rule_defaults', grantId: GRANT }],
};
const walletNeed = (amount: string, currencyCode = 'IRR'): DecisionPrediction => ({
  id: 'pr-wallet', kind: 'wallet_need', value: Number(amount), amount, currencyCode, predictedAt: null, confidence: 0.7,
  reasons: [
    { code: 'next_two_renewals', grantId: GRANT, variantId: 'v50', price: '200000.00', currencyCode },
    { code: 'available', amount: '50000.00', currencyCode },
    { code: 'rounded_to_preset', need: '350000.00', preset: '400000.00' },
  ],
});

function inputs(predictions: DecisionPrediction[], endsInDays = 5, over: Partial<CandidateInputs> = {}): CandidateInputs {
  return {
    predictions,
    grants: new Map([[GRANT, { id: GRANT, variantId: 'v50', endsAt: new Date(NOW.getTime() + endsInDays * DAY) }]]),
    plans: new Map([['v50', plan('v50', '200000')]]),
    ...over,
  };
}

describe('top_up_wallet candidates (F-038-k)', () => {
  it('takes the place of the renewal when the wallet is short: one candidate, the amount exact, with its currency', () => {
    const out = candidatesFor(inputs([renewal, walletNeed('400000.00')]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      actionType: 'top_up_wallet',
      predictionId: 'pr-wallet',
      confidence: 0.7,
      templateKey: 'suggestion.top_up_wallet',
      grantId: GRANT,
      targetVariantId: 'v50',
      deadline: new Date(NOW.getTime() + 5 * DAY),
    });
    expect(out[0].reasons).toContainEqual({ code: 'suggest_top_up', grantId: GRANT, amount: '400000.00', currencyCode: 'IRR' });
    // The renewal it funds: the same plan, so the outcome and the report key on the same Grant.
    expect(out[0].reasons[0]).toMatchObject({ code: 'suggest_variant', grantId: GRANT, variantId: 'v50', fromVariantId: 'v50' });
  });

  it('is worth the renewal it funds: the same expected margin the renewal would carry', () => {
    const [renew] = candidatesFor(inputs([renewal]), NOW);
    const [topUp] = candidatesFor(inputs([renewal, walletNeed('400000.00')]), NOW);
    expect(renew.actionType).toBe('renew');
    expect(topUp.expectedMargin).toEqual(renew.expectedMargin);
  });

  it('keeps the renewal when the wallet already holds two periods (no wallet_need)', () => {
    expect(candidatesFor(inputs([renewal]), NOW).map((c) => c.actionType)).toEqual(['renew']);
  });

  it('is not told weeks ahead: nothing before the Grant is inside the lead time', () => {
    expect(candidatesFor(inputs([renewal, walletNeed('400000.00')], 20), NOW)).toEqual([]);
  });

  it('never funds a plan in another currency: the renewal stays', () => {
    expect(candidatesFor(inputs([renewal, walletNeed('40.00', 'USD')]), NOW).map((c) => c.actionType)).toEqual(['renew']);
  });

  it('never displaces a resize: the right size is the better news', () => {
    const plans = new Map([['v50', plan('v50', '200000')], ['v100', { ...plan('v100', '350000'), size: BigInt(100) * BigInt(1024 ** 3) }]]);
    const up: DecisionPrediction = { id: 'pr-size', kind: 'right_size', value: 1.8, predictedAt: null, confidence: 0.75, reasons: [{ code: 'size_up', grantId: GRANT }] };
    const out = candidatesFor(inputs([renewal, up, walletNeed('400000.00')], 5, { plans }), NOW);
    expect(out.map((c) => [c.actionType, c.targetVariantId])).toEqual([['resize_up', 'v100']]);
  });

  it('a wallet_need about another Grant leaves this one’s renewal alone', () => {
    const other = { ...walletNeed('400000.00'), reasons: [{ code: 'next_two_renewals', grantId: 'another', variantId: 'v50', price: '200000.00', currencyCode: 'IRR' }] };
    expect(candidatesFor(inputs([renewal, other]), NOW).map((c) => c.actionType)).toEqual(['renew']);
  });
});

describe('top_up_wallet delivery item (F-038-k)', () => {
  it('carries the amount to tell, as a decimal string with its currency; other types carry none', () => {
    const row = {
      id: 'a1', tenantId: 't1', subjectKind: 'user' as const, subjectId: 'u1', status: 'scheduled' as const,
      templateKey: 'suggestion.top_up_wallet', renderedBy: 'template' as const, renderedText: null, deadline: null,
    };
    const [topUp] = candidatesFor(inputs([renewal, walletNeed('400000.00')]), NOW);
    expect(deliveryItem({ ...row, actionType: 'top_up_wallet', reasons: topUp.reasons as Prisma.JsonValue })).toMatchObject({
      grantId: GRANT,
      variantId: 'v50',
      amount: { amount: '400000.00', currencyCode: 'IRR' },
    });
    const [renew] = candidatesFor(inputs([renewal]), NOW);
    expect(deliveryItem({ ...row, actionType: 'renew', reasons: renew.reasons as Prisma.JsonValue }).amount).toBeNull();
  });
});
