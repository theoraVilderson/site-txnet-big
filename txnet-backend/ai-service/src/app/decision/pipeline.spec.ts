import { Prisma } from '@prisma/client';

import type { AiTenantMode } from '../policy/ai-defaults';
import { candidatesFor, SUGGEST_LEAD_DAYS, type CandidateInputs, type DecisionPrediction, type PlanOption } from './candidates';
import { expectedMargin } from './margin';
import { DecisionPipeline, type SubjectDecisionInputs } from './pipeline';
import { scheduleAt } from './schedule';

/**
 * F-038-e / ADR-0109 point 8: the decision pipeline — candidates by rules,
 * then threshold, opt-out, cooldown, quiet-down, holdout, attention budget,
 * the highest expected margin, offer guardrails, and a time: the subject's
 * next active hour outside their quiet hours, before the action's deadline.
 *
 * The failures worth a spec: a pitch weeks before it matters; a renewal and a
 * resize of the same Grant both sent; the bigger plan picked by revenue when
 * the margin says otherwise; a step skipped or run out of order; a suggestion
 * scheduled into the user's night or after its deadline; and an hourly run
 * that writes the same stopped row 24 times a day.
 */

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-000000000001';
const GRANT = '00000000-0000-4000-8000-0000000000b1';
const NOW = new Date('2026-10-05T09:20:00Z'); // a Monday
const DAY = 86_400_000;
const GIB = BigInt(1024 ** 3);
const IRR = 'IRR';

const plan = (variantId: string, gib: number, price: number | null): PlanOption => ({
  variantId,
  productId: 'p1',
  billingMode: 'prepaid',
  durationDays: 30,
  size: BigInt(gib) * GIB,
  price: price === null ? null : { amount: new Prisma.Decimal(price), currencyCode: IRR },
});

const renewal = (value: number, confidence = 0.7): DecisionPrediction => ({
  id: 'pr-renew',
  kind: 'renewal_probability',
  value,
  predictedAt: new Date(NOW.getTime() + 3 * DAY),
  confidence,
  reasons: [{ code: 'rule_defaults', base: 0.5, grantId: GRANT }],
});

const sizeUp = (factor: number): DecisionPrediction => ({
  id: 'pr-size',
  kind: 'right_size',
  value: factor,
  predictedAt: null,
  confidence: 0.75,
  reasons: [{ code: 'size_up', grantId: GRANT, ranOutOf: 3, ranOut: 3 }],
});

function inputs(over: Partial<CandidateInputs> = {}, endsInDays = 3): CandidateInputs {
  return {
    predictions: [renewal(0.8)],
    grants: new Map([[GRANT, { id: GRANT, variantId: 'v50', endsAt: new Date(NOW.getTime() + endsInDays * DAY) }]]),
    plans: new Map([
      ['v20', plan('v20', 20, 100_000)],
      ['v50', plan('v50', 50, 200_000)],
      ['v100', plan('v100', 100, 350_000)],
      ['v200', plan('v200', 200, 600_000)],
    ]),
    ...over,
  };
}

describe('candidates (F-038-e)', () => {
  it('suggests renewing a paid Grant that ends within the lead time, at its own plan', () => {
    const [c] = candidatesFor(inputs(), NOW);
    expect(c).toMatchObject({ actionType: 'renew', confidence: 0.7, predictionId: 'pr-renew', grantId: GRANT, targetVariantId: 'v50' });
    expect(c.deadline).toEqual(new Date(NOW.getTime() + 3 * DAY));
  });

  it('says nothing about a Grant that ends later than the lead time', () => {
    expect(candidatesFor(inputs({}, SUGGEST_LEAD_DAYS + 1), NOW)).toEqual([]);
  });

  it('suggests the bigger plan instead of the same one when the account keeps running out', () => {
    const out = candidatesFor(inputs({ predictions: [renewal(0.8), sizeUp(1.8)] }), NOW);
    expect(out.map((c) => c.actionType)).toEqual(['resize_up']);
    // 50 GiB × 1.8 = 90 GiB: the smallest plan of the product that holds it.
    expect(out[0]).toMatchObject({ targetVariantId: 'v100', predictionId: 'pr-size', confidence: 0.75 });
  });

  it('suggests a resize as soon as the bag is predicted to run out within the lead time, before the Grant ends', () => {
    const exhaustion: DecisionPrediction = {
      id: 'pr-exh',
      kind: 'meter_exhaustion',
      value: 2,
      predictedAt: new Date(NOW.getTime() + 2 * DAY),
      confidence: 0.6,
      reasons: [{ code: 'recent_rate', grantId: GRANT }],
    };
    const [c] = candidatesFor(inputs({ predictions: [sizeUp(1.5), exhaustion] }, 20), NOW);
    expect(c).toMatchObject({ actionType: 'resize_up', targetVariantId: 'v100' });
    expect(c.deadline).toEqual(exhaustion.predictedAt);
  });

  it('suggests no resize when the product has no bigger plan', () => {
    const plans = new Map([['v50', plan('v50', 50, 200_000)]]);
    expect(candidatesFor(inputs({ predictions: [sizeUp(2)], plans }), NOW)).toEqual([]);
  });

  it('never suggests a plan with no price, or one of another product, mode or length', () => {
    const plans = new Map<string, PlanOption>([
      ['v50', plan('v50', 50, 200_000)],
      ['vfree', plan('vfree', 100, null)],
      ['vother', { ...plan('vother', 100, 300_000), productId: 'p2' }],
      ['vyear', { ...plan('vyear', 100, 300_000), durationDays: 365 }],
    ]);
    expect(candidatesFor(inputs({ predictions: [sizeUp(2)], plans }), NOW)).toEqual([]);
    expect(candidatesFor(inputs({ plans: new Map([['v50', plan('v50', 50, null)]]) }), NOW)).toEqual([]);
  });
});

describe('expected margin (F-038-e, ADR-0109 point 8)', () => {
  it('is the renewal probability times price minus cost, in the price currency (C-02)', () => {
    const m = expectedMargin(0.8, { amount: new Prisma.Decimal(200_000), currencyCode: IRR }, new Prisma.Decimal(120_000));
    expect(m.amount).toBe('64000.00');
    expect(m.currencyCode).toBe(IRR);
    expect(m.reason).toMatchObject({ code: 'expected_margin', probability: 0.8, price: '200000.00', cost: '120000.00' });
  });

  it('says so when the cost is not known: the amount is only an upper bound, ranked after known costs (F-038-p2)', () => {
    const m = expectedMargin(0.5, { amount: new Prisma.Decimal(100_000), currencyCode: IRR }, null);
    expect(m.amount).toBe('50000.00');
    expect(m.reason).toMatchObject({ code: 'expected_margin', cost: null, costKnown: false });
  });
});

describe('scheduleAt (F-038-e, ADR-0108)', () => {
  // Hour of week, Monday 00:00 UTC = 0. Active: Monday 15:00 and 18:00 UTC.
  const hours = new Array<number>(168).fill(0);
  hours[15] = 0.5;
  hours[18] = 0.5;
  const deadline = new Date(NOW.getTime() + 3 * DAY);

  it('picks the next hour the subject is usually active', () => {
    expect(scheduleAt({ activeHours: hours, quiet: null, deadline, now: NOW })?.toISOString()).toBe('2026-10-05T15:00:00.000Z');
  });

  it('skips an active hour inside the user quiet window, in their zone', () => {
    // 18:00–20:00 Tehran = 14:30–16:30 UTC: 15:00 is quiet, 18:00 UTC is not.
    const quiet = { quietStart: 18 * 60, quietEnd: 20 * 60, timezone: 'Asia/Tehran' };
    expect(scheduleAt({ activeHours: hours, quiet, deadline, now: NOW })?.toISOString()).toBe('2026-10-05T18:00:00.000Z');
  });

  it('with no known pattern, goes now — unless now is quiet, then at the window end', () => {
    const none = new Array<number>(168).fill(0);
    expect(scheduleAt({ activeHours: none, quiet: null, deadline, now: NOW })).toEqual(NOW);
    const night = { quietStart: 12 * 60, quietEnd: 14 * 60, timezone: 'Asia/Tehran' }; // 08:30–10:30 UTC
    expect(scheduleAt({ activeHours: none, quiet: night, deadline, now: NOW })?.toISOString()).toBe('2026-10-05T10:30:00.000Z');
  });

  it('never after the deadline: the first hour outside the quiet window instead, or nothing', () => {
    const soon = new Date(NOW.getTime() + 2 * 3_600_000);
    expect(scheduleAt({ activeHours: hours, quiet: null, deadline: soon, now: NOW })).toEqual(NOW);
    const allDay = { quietStart: 0, quietEnd: 23 * 60 + 59, timezone: 'UTC' };
    expect(scheduleAt({ activeHours: hours, quiet: allDay, deadline: soon, now: NOW })).toBeNull();
    expect(scheduleAt({ activeHours: hours, quiet: null, deadline: new Date(NOW.getTime() - 1), now: NOW })).toBeNull();
  });
});

describe('DecisionPipeline (F-038-e)', () => {
  const MODE: AiTenantMode = {
    engineRuns: true,
    actionTypes: ['renew', 'resize_up', 'resize_down'],
    languageLayer: 'off',
    modelText: {},
    confidenceThreshold: 0.6,
    holdoutPercent: 10,
  };
  const subject = { tenantId: TENANT, kind: 'user' as const, id: USER };

  function harness(over: { optOut?: boolean; cooldown?: boolean; quiet?: boolean; holdout?: boolean; budget?: boolean } = {}) {
    const calls: string[] = [];
    const step = (name: string, stop: boolean | undefined, by: string) => vi.fn(async () => {
      calls.push(name);
      return stop ? { pass: false, suppressedBy: by, retryAt: null } : { pass: true };
    });
    const deps = {
      optOuts: { verdict: step('opt_out', over.optOut, 'opt_out') },
      cooldown: { verdict: step('cooldown', over.cooldown, 'cooldown') },
      quietDown: { inputs: vi.fn(async () => ({ openTicket: !!over.quiet, lastFailedPaymentAt: null })) },
      holdouts: { verdict: step('holdout', over.holdout, 'holdout') },
      budget: { peek: vi.fn(async () => (over.budget ? { allowed: false, limit: 'per_day', retryAt: new Date(NOW.getTime() + DAY) } : { allowed: true })) },
      log: { record: vi.fn(async (_s: unknown, c: { actionType: string }, o: { status: string }) => ({ id: `a-${c.actionType}`, actionType: c.actionType, ...o })) },
      offers: { active: vi.fn(async () => true) },
    };
    const pipeline = new DecisionPipeline(
      deps.optOuts as never,
      deps.cooldown as never,
      deps.quietDown as never,
      deps.holdouts as never,
      deps.budget as never,
      deps.log as never,
      deps.offers as never,
    );
    return { pipeline, deps, calls };
  }

  const decisionInputs = (over: Partial<SubjectDecisionInputs> = {}): SubjectDecisionInputs => ({
    candidates: inputs(),
    activeHours: new Array<number>(168).fill(0),
    quiet: null,
    pendingSends: [],
    stoppedToday: [],
    ...over,
  });

  it('runs the steps in order and schedules a candidate that passes them all', async () => {
    const { pipeline, deps, calls } = harness();
    const out = await pipeline.decide(subject, MODE, decisionInputs(), NOW);
    expect(calls).toEqual(['opt_out', 'cooldown', 'holdout']);
    expect(deps.quietDown.inputs).toHaveBeenCalled();
    expect(deps.budget.peek).toHaveBeenCalledWith(subject, NOW, []);
    expect(out).toEqual([expect.objectContaining({ actionType: 'renew', status: 'scheduled', scheduledFor: NOW })]);
    const [, candidate] = deps.log.record.mock.calls[0];
    expect(candidate).toMatchObject({ expectedMargin: { amount: '160000.00', currencyCode: IRR } });
    expect((candidate as unknown as { reasons: Array<{ code: string }> }).reasons.map((r) => r.code)).toEqual(
      expect.arrayContaining(['suggest_variant', 'expected_margin', 'rule_defaults']),
    );
  });

  it('stops a candidate under the threshold before asking anything else, and records the step', async () => {
    const { pipeline, deps, calls } = harness();
    await pipeline.decide(subject, MODE, decisionInputs({ candidates: inputs({ predictions: [renewal(0.8, 0.59)] }) }), NOW);
    expect(calls).toEqual([]);
    expect(deps.log.record).toHaveBeenCalledWith(subject, expect.anything(), { status: 'suppressed', suppressedBy: 'confidence_threshold' }, NOW);
  });

  it.each([
    ['opt_out', { optOut: true }, ['opt_out']],
    ['cooldown', { cooldown: true }, ['opt_out', 'cooldown']],
    ['quiet_down', { quiet: true }, ['opt_out', 'cooldown']],
    ['holdout', { holdout: true }, ['opt_out', 'cooldown', 'holdout']],
    ['attention_budget', { budget: true }, ['opt_out', 'cooldown', 'holdout']],
  ] as const)('a candidate stopped by %s is recorded with that step and goes no further', async (by, over, ran) => {
    const { pipeline, deps, calls } = harness(over);
    await pipeline.decide(subject, MODE, decisionInputs(), NOW);
    expect(calls).toEqual(ran);
    expect(deps.log.record).toHaveBeenCalledWith(subject, expect.anything(), { status: 'suppressed', suppressedBy: by }, NOW);
  });

  it('a type the tenant switched off is not even a candidate', async () => {
    const { pipeline, deps } = harness();
    await pipeline.decide(subject, { ...MODE, actionTypes: ['resize_up'] }, decisionInputs(), NOW);
    expect(deps.log.record).not.toHaveBeenCalled();
  });

  it('keeps the highest expected margin, not the highest price; the other is stopped by margin', async () => {
    const OTHER = '00000000-0000-4000-8000-000000000002';
    const candidates = inputs({
      predictions: [renewal(0.8), { ...renewal(0.9), id: 'pr-2', reasons: [{ code: 'rule_defaults', grantId: OTHER }] }],
      grants: new Map([
        [GRANT, { id: GRANT, variantId: 'v200', endsAt: new Date(NOW.getTime() + 2 * DAY) }],
        [OTHER, { id: OTHER, variantId: 'v50', endsAt: new Date(NOW.getTime() + 2 * DAY) }],
      ]),
      // v200 earns 600k but costs 560k (margin 0.8 × 40k = 32k); v50 earns 0.9 × 80k = 72k.
      plans: new Map([
        ['v50', plan('v50', 50, 200_000)],
        ['v200', plan('v200', 200, 600_000)],
      ]),
      wholesale: new Map([
        [GRANT, { meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: new Prisma.Decimal(2_800), currencyCode: IRR }],
        [OTHER, { meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: new Prisma.Decimal(2_400), currencyCode: IRR }],
      ]),
    });
    const { pipeline, deps } = harness();
    const out = await pipeline.decide(subject, MODE, decisionInputs({ candidates }), NOW);
    expect(out.filter((a) => a.status === 'scheduled')).toHaveLength(1);
    const outcomes = deps.log.record.mock.calls.map(([, c, o]) => [(c as unknown as { grantId: string }).grantId, (o as { status: string; suppressedBy?: string }).suppressedBy ?? (o as { status: string }).status]);
    expect(outcomes).toEqual(expect.arrayContaining([[OTHER, 'scheduled'], [GRANT, 'margin']]));
  });

  it('never schedules a suggestion that loses the seller money (F-038-p)', async () => {
    const { pipeline, deps } = harness();
    const wholesale = new Map([[GRANT, { meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: new Prisma.Decimal(5_000), currencyCode: IRR }]]);
    await pipeline.decide(subject, MODE, decisionInputs({ candidates: inputs({ wholesale }) }), NOW);
    expect(deps.log.record).toHaveBeenCalledWith(subject, expect.anything(), { status: 'suppressed', suppressedBy: 'margin' }, NOW);
    expect(deps.log.record).toHaveBeenCalledTimes(1);
  });

  // F-038-p2: an unknown cost is no cost of zero — price × P is only an upper bound on what it earns.
  const outcomesOf = (deps: ReturnType<typeof harness>['deps']) =>
    deps.log.record.mock.calls.map(([, c, o]) => [(c as unknown as { grantId?: string; actionType: string }).grantId ?? (c as { actionType: string }).actionType, (o as { suppressedBy?: string }).suppressedBy ?? (o as { status: string }).status]);

  it('ranks a known cost before an unknown one, however large the unknown one looks (F-038-p2)', async () => {
    const OTHER = '00000000-0000-4000-8000-000000000002';
    // GRANT has no wholesale leg: 0.8 × 600k = 480k if its cost were zero. OTHER is known: 0.9 × (200k − 120k) = 72k.
    const candidates = inputs({
      predictions: [renewal(0.8), { ...renewal(0.9), id: 'pr-2', reasons: [{ code: 'rule_defaults', grantId: OTHER }] }],
      grants: new Map([
        [GRANT, { id: GRANT, variantId: 'v200', endsAt: new Date(NOW.getTime() + 2 * DAY) }],
        [OTHER, { id: OTHER, variantId: 'v50', endsAt: new Date(NOW.getTime() + 2 * DAY) }],
      ]),
      plans: new Map([['v50', plan('v50', 50, 200_000)], ['v200', plan('v200', 200, 600_000)]]),
      wholesale: new Map([[OTHER, { meterKey: 'vpn.traffic', unitSize: GIB, unitPrice: new Prisma.Decimal(2_400), currencyCode: IRR }]]),
    });
    const { pipeline, deps } = harness();
    await pipeline.decide(subject, MODE, decisionInputs({ candidates }), NOW);
    expect(outcomesOf(deps)).toEqual(expect.arrayContaining([[OTHER, 'scheduled'], [GRANT, 'margin']]));
  });

  it('still ranks a sale of unknown cost above help, which earns nothing (F-038-p2)', async () => {
    const checkouts = [{ paymentId: 'pay-1', status: 'failed' as const, at: new Date(NOW.getTime() - 3_600_000), amount: '200000.00', currencyCode: IRR }];
    const { pipeline, deps } = harness();
    await pipeline.decide(subject, { ...MODE, actionTypes: [...MODE.actionTypes, 'checkout_help'] }, decisionInputs({ candidates: inputs({ checkouts }) }), NOW);
    expect(outcomesOf(deps)).toEqual(expect.arrayContaining([[GRANT, 'scheduled'], ['checkout_help', 'margin']]));
  });

  it('a candidate with no time left before its deadline outside quiet hours is stopped by schedule', async () => {
    const { pipeline, deps } = harness();
    const allDay = { quietStart: 0, quietEnd: 23 * 60 + 59, timezone: 'UTC' };
    const candidates = inputs({ grants: new Map([[GRANT, { id: GRANT, variantId: 'v50', endsAt: new Date(NOW.getTime() + 3_600_000) }]]) });
    await pipeline.decide(subject, MODE, decisionInputs({ candidates, quiet: allDay }), NOW);
    expect(deps.log.record).toHaveBeenCalledWith(subject, expect.anything(), { status: 'suppressed', suppressedBy: 'schedule' }, NOW);
  });

  it('writes a stopped row once a day per type and step, not every hour', async () => {
    const { pipeline, deps } = harness({ holdout: true });
    await pipeline.decide(subject, MODE, decisionInputs({ stoppedToday: [{ actionType: 'renew', suppressedBy: 'holdout' }] }), NOW);
    expect(deps.log.record).not.toHaveBeenCalled();
  });

  it('peeks at the budget with what is already scheduled, and never charges it — delivery does (F-1548)', async () => {
    const { pipeline, deps } = harness();
    const pending = [new Date(NOW.getTime() + 3_600_000)];
    await pipeline.decide(subject, MODE, decisionInputs({ pendingSends: pending }), NOW);
    expect(deps.budget.peek).toHaveBeenCalledWith(subject, NOW, pending);
  });
});
