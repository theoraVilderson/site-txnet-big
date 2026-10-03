import { Prisma } from '@prisma/client';

import type { AiTenantMode } from '../policy/ai-defaults';
import { candidatesFor, WHEEL_INVITE_LEAD_DAYS, WHEEL_UNSPUN_DAYS, type CandidateInputs, type DecisionPrediction, type PlanOption } from './candidates';
import { DecisionPipeline, type SubjectDecisionInputs } from './pipeline';

/**
 * F-038-u (ADR-0109 point 15, user 2026-10-03): the engine invites a user to
 * the tenant's wheel — one who may spin, has not for a week, and whose
 * renewal is predicted under 0.5. The odds are the wheel's, the same for
 * everyone: the engine picks who and when, never what they win.
 *
 * The failures worth a spec: an invite where the tenant runs no wheel; one to
 * a user who spun this week, or to one who renews anyway (a prize spent on a
 * sale already made); an invite that outranks a sale the same run; and an
 * invite that lingers past its day.
 */

const TENANT = '00000000-0000-4000-8000-0000000000aa';
const USER = '00000000-0000-4000-8000-000000000001';
const GRANT = '00000000-0000-4000-8000-0000000000b1';
const SECOND = '00000000-0000-4000-8000-0000000000b2';
const NOW = new Date('2026-10-05T09:20:00Z');
const DAY = 86_400_000;
const GIB = BigInt(1024 ** 3);

const plan: PlanOption = {
  variantId: 'v50',
  productId: 'p1',
  billingMode: 'prepaid',
  durationDays: 30,
  size: BigInt(50) * GIB,
  price: { amount: new Prisma.Decimal(200_000), currencyCode: 'IRR' },
};

const renewal = (value: number, grantId = GRANT, id = 'pr-renew'): DecisionPrediction => ({
  id,
  kind: 'renewal_probability',
  value,
  predictedAt: null,
  confidence: 0.7,
  reasons: [{ code: 'rule_defaults', base: 0.5, grantId }],
});

function inputs(over: Partial<CandidateInputs> = {}, endsInDays = 10): CandidateInputs {
  return {
    predictions: [renewal(0.3)],
    grants: new Map([
      [GRANT, { id: GRANT, variantId: 'v50', endsAt: new Date(NOW.getTime() + endsInDays * DAY) }],
      [SECOND, { id: SECOND, variantId: 'v50', endsAt: new Date(NOW.getTime() + endsInDays * DAY) }],
    ]),
    plans: new Map([['v50', plan]]),
    wheel: { lastSpunAt: null },
    ...over,
  };
}

const invites = (i: CandidateInputs) => candidatesFor(i, NOW).filter((c) => c.actionType === 'wheel_invite');

describe('wheel_invite candidates (F-038-u)', () => {
  it('invites an at-risk user who may spin, for a day, about no Grant and with no margin', () => {
    const [c] = invites(inputs());
    expect(c).toMatchObject({ actionType: 'wheel_invite', confidence: 0.7, predictionId: 'pr-renew', deadline: new Date(NOW.getTime() + DAY) });
    expect(c.grantId).toBeUndefined();
    expect(c.expectedMargin).toBeUndefined();
    expect(c.reasons[0]).toMatchObject({ code: 'wheel_invite', grantId: GRANT, renewalProbability: 0.3, lastSpunAt: null });
  });

  it('invites no one where the tenant runs no wheel today', () => {
    expect(invites(inputs({ wheel: null }))).toEqual([]);
    expect(invites(inputs({ wheel: undefined }))).toEqual([]);
  });

  it(`waits ${WHEEL_UNSPUN_DAYS} days after the user's last spin`, () => {
    const spun = (daysAgo: number) => invites(inputs({ wheel: { lastSpunAt: new Date(NOW.getTime() - daysAgo * DAY) } }));
    expect(spun(6.9)).toEqual([]);
    expect(spun(WHEEL_UNSPUN_DAYS)).toHaveLength(1);
  });

  it('never invites a user predicted to renew anyway', () => {
    expect(invites(inputs({ predictions: [renewal(0.5)] }))).toEqual([]);
  });

  it(`looks only at Grants ending within ${WHEEL_INVITE_LEAD_DAYS} days, and never past the end`, () => {
    expect(invites(inputs({}, WHEEL_INVITE_LEAD_DAYS + 1))).toEqual([]);
    expect(invites(inputs({}, -1))).toEqual([]);
    const [soon] = invites(inputs({}, 0.5));
    expect(soon.deadline).toEqual(new Date(NOW.getTime() + 0.5 * DAY));
  });

  it('one invite per user, naming the Grant least likely to renew', () => {
    const out = invites(inputs({ predictions: [renewal(0.4), renewal(0.2, SECOND, 'pr-second')] }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ predictionId: 'pr-second' });
    expect(out[0].reasons[0]).toMatchObject({ grantId: SECOND });
  });
});

describe('DecisionPipeline with a wheel invite (F-038-u)', () => {
  const MODE: AiTenantMode = {
    engineRuns: true,
    actionTypes: ['renew', 'wheel_invite'],
    languageLayer: 'off',
    modelText: {},
    confidenceThreshold: 0.6,
    holdoutPercent: 10,
  };
  const subject = { tenantId: TENANT, kind: 'user' as const, id: USER };

  function pipeline() {
    const pass = vi.fn(async () => ({ pass: true }));
    const log = { record: vi.fn(async (_s: unknown, c: { actionType: string }, o: Record<string, unknown>) => ({ id: `a-${c.actionType}`, actionType: c.actionType, ...o })) };
    const p = new DecisionPipeline(
      { verdict: pass } as never,
      { verdict: pass } as never,
      { inputs: vi.fn(async () => ({ openTicket: false, lastFailedPaymentAt: null })) } as never,
      { verdict: pass } as never,
      { peek: vi.fn(async () => ({ allowed: true })) } as never,
      log as never,
      { allowed: vi.fn(async () => true) } as never,
    );
    return { p, log };
  }

  const decisionInputs = (candidates: CandidateInputs): SubjectDecisionInputs => ({
    candidates,
    activeHours: new Array<number>(168).fill(0),
    quiet: null,
    pendingSends: [],
    stoppedToday: [],
  });

  it('schedules the invite when nothing is for sale', async () => {
    const { p } = pipeline();
    const out = await p.decide(subject, MODE, decisionInputs(inputs()), NOW);
    expect(out).toEqual([expect.objectContaining({ actionType: 'wheel_invite', status: 'scheduled' })]);
  });

  it('a sale the same run wins: the renewal is scheduled, the invite stopped by margin', async () => {
    const { p } = pipeline();
    // Ends in 3 days: a renewal is due, and its renewal is still predicted under 0.5.
    const out = await p.decide(subject, MODE, decisionInputs(inputs({}, 3)), NOW);
    expect(out).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actionType: 'renew', status: 'scheduled' }),
        expect.objectContaining({ actionType: 'wheel_invite', status: 'suppressed', suppressedBy: 'margin' }),
      ]),
    );
  });
});
