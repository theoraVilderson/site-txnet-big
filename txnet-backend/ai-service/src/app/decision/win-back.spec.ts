import { Prisma } from '@prisma/client';

import { winBackWindow } from '../profile/predictions';
import type { AccountInputs } from '../profile/profile-features';
import { candidatesFor, type CandidateInputs, type DecisionPrediction, type PlanOption } from './candidates';
import { deliveryItem } from './delivery';
import { matchOutcome, type OutcomeEvent } from './outcome';

/**
 * F-038-n / ADR-0109 point 7: `win_back` — an account 14, 30 or 60 days
 * without an active Grant is told its last plan once per window, on the day
 * the window closes (`WIN_BACK_LEAD_DAYS` before it at most), never earlier.
 *
 * The failures worth a spec: a pitch a week after the service ended, when the
 * user may still be deciding; two pitches inside one window; a plan the
 * tenant no longer prices; a suggestion that cannot say which service it is
 * about, so delivery cannot name it.
 */

const GRANT = '00000000-0000-4000-8000-0000000000e1';
const NOW = new Date('2026-10-05T09:20:00Z');
const DAY = 86_400_000;

const plan = (variantId: string, price: string | null): PlanOption => ({
  variantId,
  productId: 'p1',
  billingMode: 'prepaid',
  durationDays: 30,
  size: BigInt(50) * BigInt(1024 ** 3),
  price: price === null ? null : { amount: new Prisma.Decimal(price), currencyCode: 'IRR' },
});

/** The stored prediction as `winBackWindow` writes it: the window closes in `closesInHours`. */
const winBack = (closesInHours: number, days = 14, confidence = 0.65): DecisionPrediction => ({
  id: 'pr-wb',
  kind: 'win_back_window',
  value: days - 1,
  predictedAt: new Date(NOW.getTime() + closesInHours * 3_600_000),
  confidence,
  reasons: [
    { code: 'no_active_grant', grantId: GRANT, since: new Date(NOW.getTime() - (days - 1) * DAY).toISOString() },
    { code: 'window', days },
    { code: 'signed_in_since' },
  ],
});

function inputs(predictions: DecisionPrediction[], price: string | null = '200000', over: Partial<CandidateInputs> = {}): CandidateInputs {
  return {
    predictions,
    grants: new Map([[GRANT, { id: GRANT, variantId: 'v50', endsAt: new Date(NOW.getTime() - 13 * DAY) }]]),
    plans: new Map([['v50', plan('v50', price)]]),
    ...over,
  };
}

describe('win_back candidates (F-038-n)', () => {
  it('names the last Grant\'s plan on the day its window closes, with the window as deadline', () => {
    const out = candidatesFor(inputs([winBack(20)]), NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      actionType: 'win_back',
      predictionId: 'pr-wb',
      confidence: 0.65,
      templateKey: 'suggestion.win_back',
      grantId: GRANT,
      targetVariantId: 'v50',
      deadline: new Date(NOW.getTime() + 20 * 3_600_000),
      // No renewal is predicted for an ended Grant: the prediction's confidence is the chance of return.
      expectedMargin: { amount: '130000.00', currencyCode: 'IRR' },
    });
    expect(out[0].reasons[0]).toEqual({ code: 'suggest_variant', grantId: GRANT, fromVariantId: 'v50', variantId: 'v50', price: '200000.00', currencyCode: 'IRR' });
    expect(out[0].reasons).toContainEqual({ code: 'window', days: 14 });
  });

  it('proposes nothing while the window is more than a day from closing', () => {
    expect(candidatesFor(inputs([winBack(25)]), NOW)).toEqual([]);
    expect(candidatesFor(inputs([winBack(6 * 24)]), NOW)).toEqual([]);
  });

  it('proposes nothing for a plan with no price, or a Grant it cannot read', () => {
    expect(candidatesFor(inputs([winBack(20)], null), NOW)).toEqual([]);
    expect(candidatesFor(inputs([winBack(20)], '200000', { grants: new Map() }), NOW)).toEqual([]);
  });

  it('never stands beside a renewal: an account with an active Grant has no win-back prediction to start from', () => {
    const renewal: DecisionPrediction = {
      id: 'pr-renew', kind: 'renewal_probability', value: 0.6, predictedAt: null, confidence: 0.7,
      reasons: [{ code: 'rule_defaults', grantId: GRANT }],
    };
    const out = candidatesFor(inputs([renewal, winBack(20)]), NOW);
    expect(out.map((c) => c.actionType)).toEqual(['win_back']);
  });
});

describe('the win-back prediction carries the Grant it is about (F-038-n)', () => {
  const ended = (id: string, daysAgo: number) => ({
    id,
    variantId: 'v50',
    source: 'purchase',
    status: 'expired',
    billingMode: 'prepaid',
    trafficUnlimited: false,
    purchasedBytes: BigInt(0),
    consumedBytes: BigInt(0),
    startsAt: new Date(NOW.getTime() - (daysAgo + 30) * DAY),
    endsAt: new Date(NOW.getTime() - daysAgo * DAY),
    updatedAt: new Date(NOW.getTime() - daysAgo * DAY + 3_600_000),
  });
  const account = (grants: unknown[]) =>
    ({ userId: 'u1', createdAt: new Date(NOW.getTime() - 200 * DAY), grants, renewals: [], readings: [], walletTransactions: [], wallet: null, payments: [], signIns: [], notices: [] }) as unknown as AccountInputs;

  it('names the Grant that ended last, first in its reasons', () => {
    const p = winBackWindow(account([ended('g-old', 40), ended(GRANT, 13)]), NOW);
    expect(p?.reasons[0]).toMatchObject({ code: 'no_active_grant', grantId: GRANT });
  });
});

describe('win_back delivery and outcome (F-038-n)', () => {
  const row = {
    id: 'a1', tenantId: 't1', subjectKind: 'user' as const, subjectId: 'u1', actionType: 'win_back' as const, status: 'scheduled' as const,
    templateKey: 'suggestion.win_back', renderedBy: 'template' as const, renderedText: null, deadline: new Date(NOW.getTime() + DAY),
    reasons: [{ code: 'suggest_variant', grantId: GRANT, fromVariantId: 'v50', variantId: 'v50', price: '200000.00', currencyCode: 'IRR' }],
  };

  it('is delivered with the ended Grant and its plan, so the worker can name both', () => {
    expect(deliveryItem(row)).toMatchObject({ actionType: 'win_back', grantId: GRANT, variantId: 'v50', price: { amount: '200000.00', currencyCode: 'IRR' } });
  });

  it('converts on a paid invoice for the plan it named, inside the window', () => {
    const paid = (variantId: string, daysAfter: number): OutcomeEvent => ({
      kind: 'purchase', ref: `inv-${variantId}`, userId: 'u1', at: new Date(NOW.getTime() + daysAfter * DAY), variantId, grantId: null, amount: '200000.00', currencyCode: 'IRR',
    });
    const action = { actionType: 'win_back', subjectId: 'u1', createdAt: NOW, sentAt: NOW, reasons: row.reasons };
    expect(matchOutcome(action, [paid('v50', 3)])).toMatchObject({ ref: 'inv-v50', amount: '200000.00' });
    expect(matchOutcome(action, [paid('v99', 3)])).toBeNull();
    expect(matchOutcome(action, [paid('v50', 9)])).toBeNull();
  });
});
