import { Prisma } from '@prisma/client';

import type { AiTenantMode } from '../policy/ai-defaults';
import { candidatesFor, type CandidateInputs, type DecisionPrediction, type OfferOption, type PlanOption } from './candidates';
import { DecisionPipeline, type SubjectDecisionInputs } from './pipeline';
import { heldByPrize, NO_PRIZE_HOLD, prizeHold, prizeStops, type PrizeGrant, type PrizeRecord } from './prize-hold';

/**
 * F-038-y (ADR-0111 point 2, ADR-0110): the engine knows a prize. A winner of
 * three free days must not get a renewal nudge the same hour, and a prize
 * coupon must never sit beside an offer coupon.
 *
 * The failures worth a spec: a nudge about the Grant the prize just went to,
 * decided or already queued; a hold that never lets go (after a renewal, a
 * used coupon, a closed Grant), which would silence the renewal for good; an
 * offer coupon issued while a prize coupon is unused; and a hold that leaks
 * onto help (`usage_alert`) or onto another Grant.
 */

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-000000000001';
const GRANT = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const NOW = new Date('2026-10-05T09:20:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GIB = BigInt(1024 ** 3);
const IRR = 'IRR';

const grant = (over: Partial<PrizeGrant> = {}): PrizeGrant => ({
  id: GRANT,
  status: 'active',
  endsAt: new Date(NOW.getTime() + 5 * DAY),
  purchasedBytes: BigInt(55) * GIB,
  consumedBytes: BigInt(40) * GIB,
  usagePeriodStartedAt: new Date(NOW.getTime() - 25 * DAY),
  ...over,
});

const days = (over: Partial<PrizeGrant> = {}, endsAtBefore = new Date(NOW.getTime() + 2 * DAY)): PrizeRecord => ({
  kind: 'extra_days',
  rewardId: 'r-days',
  at: new Date(NOW.getTime() - HOUR),
  grant: grant(over),
  endsAtBefore,
});

const bytes = (over: Partial<PrizeGrant> = {}, gib = 5): PrizeRecord => ({
  kind: 'bonus_traffic_gb',
  rewardId: 'r-gb',
  at: new Date(NOW.getTime() - HOUR),
  grant: grant(over),
  bytes: BigInt(gib) * GIB,
});

const coupon = (over: Partial<Extract<PrizeRecord, { kind: 'discount_coupon' }>['coupon']> = {}): PrizeRecord => ({
  kind: 'discount_coupon',
  rewardId: 'r-coupon',
  at: new Date(NOW.getTime() - HOUR),
  coupon: { id: 'c-win', usedCount: 0, reservedCount: 0, isActive: true, expiresAt: new Date(NOW.getTime() + 7 * DAY), deletedAt: null, ...over },
});

describe('prizeHold (F-038-y)', () => {
  it('holds the Grant three free days went to until its old end passes', () => {
    expect(prizeHold([days()], NOW).grants.get(GRANT)).toMatchObject({ code: 'prize_held', rewardId: 'r-days', prizeType: 'extra_days' });
    // The days the prize added have begun: the user lives on them now, and a renewal is due.
    expect(prizeHold([days({}, new Date(NOW.getTime() - 1))], NOW).grants.size).toBe(0);
  });

  it('holds the Grant bonus GB went to until the user is using the bonus itself', () => {
    // 55 bought, 40 used: 15 left, more than the 5 won.
    expect(prizeHold([bytes()], NOW).grants.has(GRANT)).toBe(true);
    // 5 left of 55: the bonus is what remains.
    expect(prizeHold([bytes({ consumedBytes: BigInt(50) * GIB })], NOW).grants.size).toBe(0);
  });

  it('lets go once a new usage period began after the prize — a renewal, never silenced for good', () => {
    expect(prizeHold([bytes({ purchasedBytes: BigInt(105) * GIB, usagePeriodStartedAt: new Date(NOW.getTime() - 1) })], NOW).grants.size).toBe(0);
  });

  it.each([
    ['expired', { status: 'expired' as const }],
    ['suspended', { status: 'suspended' as const }],
    ['past its end', { endsAt: new Date(NOW.getTime() - 1) }],
  ])('holds nothing on a Grant %s', (_, over) => {
    expect(prizeHold([days(over), bytes(over)], NOW).grants.size).toBe(0);
  });

  it('holds an unused, live prize coupon — and lets go once it is used, reserved, expired, switched off or deleted', () => {
    expect(prizeHold([coupon()], NOW).coupon).toMatchObject({ code: 'prize_coupon', rewardId: 'r-coupon', couponId: 'c-win' });
    for (const over of [{ usedCount: 1 }, { reservedCount: 1 }, { expiresAt: NOW }, { isActive: false }, { deletedAt: new Date(NOW.getTime() - DAY) }]) {
      expect(prizeHold([coupon(over)], NOW).coupon).toBeNull();
    }
  });

  it('holds the sale types of that Grant only — never help, never another Grant', () => {
    const hold = prizeHold([days()], NOW);
    for (const t of ['renew', 'resize_up', 'resize_down', 'retain_offer', 'top_up_wallet'] as const) {
      expect(heldByPrize(hold, { actionType: t, grantId: GRANT })).toMatchObject({ code: 'prize_held' });
    }
    expect(heldByPrize(hold, { actionType: 'usage_alert', grantId: GRANT })).toBeNull();
    expect(heldByPrize(hold, { actionType: 'renew', grantId: OTHER })).toBeNull();
    expect(heldByPrize(hold, { actionType: 'checkout_help' })).toBeNull();
  });

  it('an unused prize coupon holds any offer coupon, of every Grant', () => {
    const hold = prizeHold([coupon()], NOW);
    expect(heldByPrize(hold, { actionType: 'retain_offer', grantId: OTHER })).toMatchObject({ code: 'prize_coupon' });
    expect(heldByPrize(hold, { actionType: 'renew', grantId: OTHER })).toBeNull();
  });
});

const plan = (variantId: string, gib: number, price: number): PlanOption => ({
  variantId,
  productId: 'p1',
  billingMode: 'prepaid',
  durationDays: 30,
  size: BigInt(gib) * GIB,
  price: { amount: new Prisma.Decimal(price), currencyCode: IRR },
});

const renewal = (value: number): DecisionPrediction => ({
  id: 'pr-renew',
  kind: 'renewal_probability',
  value,
  predictedAt: new Date(NOW.getTime() + 3 * DAY),
  confidence: 0.7,
  reasons: [{ code: 'rule_defaults', base: 0.5, grantId: GRANT }],
});

const OFFER: OfferOption = { id: 'off-1', variantId: null, template: null, maxDiscountPercent: new Prisma.Decimal(10), currencyCode: IRR, places: 0 };

function inputs(over: Partial<CandidateInputs> = {}): CandidateInputs {
  return {
    predictions: [renewal(0.3)],
    grants: new Map([[GRANT, { id: GRANT, variantId: 'v50', endsAt: new Date(NOW.getTime() + 3 * DAY) }]]),
    plans: new Map([['v50', plan('v50', 50, 200_000)]]),
    offers: [OFFER],
    ...over,
  };
}

describe('candidates with a prize coupon (F-038-y)', () => {
  it('suggests the renewal without an offer while a prize coupon is unused — the two never stack', () => {
    expect(candidatesFor(inputs(), NOW).map((c) => c.actionType)).toEqual(['retain_offer']);
    const [c] = candidatesFor(inputs({ prizeCoupon: prizeHold([coupon()], NOW).coupon }), NOW);
    expect(c).toMatchObject({ actionType: 'renew' });
    expect(c.offerId).toBeUndefined();
    expect((c.reasons as Array<{ code: string }>).map((r) => r.code)).toContain('prize_coupon');
  });
});

describe('DecisionPipeline with a prize (F-038-y)', () => {
  const MODE: AiTenantMode = {
    engineRuns: true,
    actionTypes: ['renew', 'resize_up', 'resize_down', 'retain_offer', 'usage_alert'],
    languageLayer: 'off',
    modelText: {},
    confidenceThreshold: 0.6,
    holdoutPercent: 10,
  };
  const subject = { tenantId: TENANT, kind: 'user' as const, id: USER };

  function harness() {
    const pass = vi.fn(async () => ({ pass: true }));
    const deps = {
      optOuts: { verdict: pass },
      cooldown: { verdict: pass },
      quietDown: { inputs: vi.fn(async () => ({ openTicket: false, lastFailedPaymentAt: null })) },
      holdouts: { verdict: pass },
      budget: { peek: vi.fn(async () => ({ allowed: true })) },
      log: { record: vi.fn(async (_s: unknown, c: { actionType: string }, o: { status: string }) => ({ id: `a-${c.actionType}`, actionType: c.actionType, ...o })) },
      offers: { allowed: vi.fn(async () => true) },
    };
    const pipeline = new DecisionPipeline(deps.optOuts as never, deps.cooldown as never, deps.quietDown as never, deps.holdouts as never, deps.budget as never, deps.log as never, deps.offers as never);
    return { pipeline, deps, pass };
  }

  const decisionInputs = (over: Partial<SubjectDecisionInputs> = {}): SubjectDecisionInputs => ({
    candidates: inputs({ predictions: [renewal(0.8)] }),
    activeHours: new Array<number>(168).fill(0),
    quiet: null,
    pendingSends: [],
    stoppedToday: [],
    ...over,
  });

  it('stops the renewal of a Grant a prize just went to, as the first step, and records why', async () => {
    const { pipeline, deps, pass } = harness();
    const out = await pipeline.decide(subject, MODE, decisionInputs({ prizes: prizeHold([days()], NOW) }), NOW);
    expect(out).toEqual([expect.objectContaining({ actionType: 'renew', status: 'suppressed', suppressedBy: 'prize' })]);
    expect(pass).not.toHaveBeenCalled();
    const [, candidate] = deps.log.record.mock.calls[0];
    expect((candidate as unknown as { reasons: Array<{ code: string }> }).reasons[0]).toMatchObject({ code: 'prize_held', rewardId: 'r-days' });
  });

  it('schedules it as before with no prize held', async () => {
    const { pipeline } = harness();
    const out = await pipeline.decide(subject, MODE, decisionInputs({ prizes: NO_PRIZE_HOLD }), NOW);
    expect(out).toEqual([expect.objectContaining({ actionType: 'renew', status: 'scheduled' })]);
  });
});

describe('prizeStops at the take (F-038-y)', () => {
  const due = (id: string, actionType: string, reasons: Array<Record<string, unknown>>, subjectKind = 'user') => ({ id, subjectKind, subjectId: USER, actionType, reasons });

  it('stops a queued nudge whose Grant won a prize after it was decided, and a queued offer beside an unused prize coupon', () => {
    const holds = new Map([[USER, prizeHold([days(), coupon()], NOW)]]);
    const rows = [
      due('a-renew', 'renew', [{ code: 'suggest_variant', grantId: GRANT }]),
      due('a-offer', 'retain_offer', [{ code: 'suggest_variant', grantId: OTHER }, { code: 'suggest_offer', offerId: 'off-1' }]),
      due('a-other', 'renew', [{ code: 'suggest_variant', grantId: OTHER }]),
      due('a-alert', 'usage_alert', [{ code: 'usage_spike', grantId: GRANT }]),
      due('a-tenant', 'resize_up', [{ code: 'suggest_package' }], 'tenant'),
    ];
    expect(prizeStops(rows, holds)).toEqual(new Set(['a-renew', 'a-offer']));
  });
});
