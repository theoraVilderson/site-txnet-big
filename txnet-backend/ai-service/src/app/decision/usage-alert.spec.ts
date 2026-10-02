import { Prisma } from '@prisma/client';

import type { AiTenantMode } from '../policy/ai-defaults';
import { utcHour } from '../profile/meter-readings';
import { USAGE_SPIKE_FACTOR, USAGE_SPIKE_MIN_BYTES, usageSpike } from '../profile/predictions';
import type { AccountInputs } from '../profile/profile-features';
import { candidatesFor, type CandidateInputs, type DecisionPrediction } from './candidates';
import { deliveryItem } from './delivery';
import { DecisionPipeline } from './pipeline';

/**
 * F-1516 (ADR-0109 points 3, 6): `usage_alert` — "in the last 24 hours this
 * service used about three times its usual day; if that wasn't you, your link
 * may be in use elsewhere too". From the Grant's own meter readings only, never
 * network data.
 *
 * The failures worth a spec: an alert for a user with no "usual" yet (a new
 * service, or one never used before); an alert over a few megabytes; the
 * alert ranked as a sale, or dropped because it has no price to rank by; and
 * a delivery item that does not say which service and how much.
 */

const NOW = new Date('2026-10-07T10:30:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GIB = BigInt(1024 ** 3);
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const anchor = utcHour(NOW).getTime();

type G = AccountInputs['grants'][number];
const grant = (id: string, over: Partial<G> = {}): G => ({
  id,
  variantId: 'v1',
  source: 'purchase',
  status: 'active',
  billingMode: 'prepaid',
  trafficUnlimited: false,
  purchasedBytes: BigInt(200) * GIB,
  consumedBytes: BigInt(40) * GIB,
  usagePeriodFromBytes: BigInt(0),
  startsAt: ago(60 * DAY),
  activatedAt: ago(60 * DAY),
  endsAt: new Date(NOW.getTime() + 20 * DAY),
  updatedAt: ago(DAY),
  ...over,
});

/**
 * A baseline row `historyDays` before the last 24 h, `usualPerDay` in each day before them (one reading at
 * noon of each day), and `lastDay` spread over the last 24 hour-keys before the current hour.
 */
function readings(grantId: string, { historyDays = 20, usualPerDay = GIB, lastDay = BigInt(4) * GIB } = {}): AccountInputs['readings'] {
  const windowStart = anchor - DAY;
  const rows: AccountInputs['readings'] = [{ grantId, meterKey: 'vpn.traffic', hour: new Date(windowStart - historyDays * DAY), delta: BigInt(0) }];
  for (let d = 1; d < historyDays; d += 1) rows.push({ grantId, meterKey: 'vpn.traffic', hour: new Date(windowStart - d * DAY + 12 * HOUR), delta: usualPerDay });
  for (let h = 1; h <= 24; h += 1) rows.push({ grantId, meterKey: 'vpn.traffic', hour: new Date(anchor - h * HOUR), delta: lastDay / BigInt(24) });
  return rows;
}

const account = (over: Partial<AccountInputs> = {}): AccountInputs => ({
  userId: 'u1',
  createdAt: ago(100 * DAY),
  grants: [grant('g1')],
  renewals: [],
  readings: readings('g1'),
  walletTransactions: [],
  wallet: null,
  payments: [],
  signIns: [],
  notices: [],
  ...over,
});

describe('usage spike prediction (F-1516)', () => {
  it('names the Grant, its last 24 hours, its usual day and the factor — from the meter readings only', () => {
    const p = usageSpike(account(), NOW);
    expect(p).toMatchObject({ kind: 'usage_spike', currencyCode: null, predictedAt: new Date(anchor + DAY) });
    expect(p?.value?.toNumber()).toBe(4);
    expect(p?.confidence).toBeGreaterThanOrEqual(0.6);
    expect(p?.reasons[0]).toEqual({
      code: 'usage_spike',
      grantId: 'g1',
      meterKey: 'vpn.traffic',
      // The fixture spreads it over 24 hour-keys, whole bytes each.
      lastDayBytes: (((BigInt(4) * GIB) / BigInt(24)) * BigInt(24)).toString(),
      usualDayBytes: GIB.toString(),
      factor: 4,
      baselineDays: 14,
    });
  });

  it(`needs ${USAGE_SPIKE_FACTOR}× the usual day: a busy day under it is no alert`, () => {
    expect(usageSpike(account({ readings: readings('g1', { lastDay: BigInt(29) * GIB / BigInt(10) }) }), NOW)).toBeNull();
    expect(usageSpike(account({ readings: readings('g1', { lastDay: BigInt(3) * GIB }) }), NOW)).not.toBeNull();
  });

  it('never alerts over a small amount, however many times the usual it is', () => {
    const tiny = { usualPerDay: USAGE_SPIKE_MIN_BYTES / BigInt(10), lastDay: USAGE_SPIKE_MIN_BYTES / BigInt(2) };
    expect(usageSpike(account({ readings: readings('g1', tiny) }), NOW)).toBeNull();
  });

  it('has no "usual" to compare with under a week of readings, or when the service was never used before', () => {
    expect(usageSpike(account({ readings: readings('g1', { historyDays: 6 }) }), NOW)).toBeNull();
    expect(usageSpike(account({ readings: readings('g1', { usualPerDay: BigInt(0) }) }), NOW)).toBeNull();
  });

  it('reads only active Grants, and of several spikes names the steepest', () => {
    expect(usageSpike(account({ grants: [grant('g1', { status: 'expired' })] }), NOW)).toBeNull();
    const two = account({
      grants: [grant('g1'), grant('g2')],
      readings: [...readings('g1'), ...readings('g2', { lastDay: BigInt(9) * GIB })],
    });
    expect(usageSpike(two, NOW)?.reasons[0]).toMatchObject({ grantId: 'g2', factor: 9 });
  });
});

const spike = (over: Partial<DecisionPrediction> = {}): DecisionPrediction => ({
  id: 'pr-spike',
  kind: 'usage_spike',
  value: 4,
  predictedAt: new Date(anchor + DAY),
  confidence: 0.7,
  reasons: [{ code: 'usage_spike', grantId: 'g1', meterKey: 'vpn.traffic', lastDayBytes: (BigInt(4) * GIB).toString(), usualDayBytes: GIB.toString(), factor: 4, baselineDays: 14 }],
  ...over,
});

const decisionInputs = (predictions: DecisionPrediction[], endsInDays = 20): CandidateInputs => ({
  predictions,
  grants: new Map([['g1', { id: 'g1', variantId: 'v1', endsAt: new Date(NOW.getTime() + endsInDays * DAY) }]]),
  plans: new Map([['v1', { variantId: 'v1', productId: 'p1', billingMode: 'prepaid', durationDays: 30, size: BigInt(200) * GIB, price: { amount: new Prisma.Decimal(200_000), currencyCode: 'IRR' } }]]),
});

describe('usage_alert candidate (F-1516)', () => {
  it('tells the spike about its Grant, by its deadline, as help: no plan, no margin', () => {
    const [c, ...rest] = candidatesFor(decisionInputs([spike()]), NOW);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      actionType: 'usage_alert',
      confidence: 0.7,
      predictionId: 'pr-spike',
      grantId: 'g1',
      templateKey: 'suggestion.usage_alert',
      deadline: new Date(anchor + DAY),
    });
    expect(c.expectedMargin).toBeUndefined();
    expect(c.targetVariantId).toBeUndefined();
    expect((c.reasons as Array<{ code: string }>).map((r) => r.code)).toEqual(['usage_spike', 'help_not_sale']);
  });

  it('says nothing once its deadline passed', () => {
    expect(candidatesFor(decisionInputs([spike({ predictedAt: ago(HOUR) })]), NOW)).toEqual([]);
  });

  it('stands beside a sale about the same Grant, and the sale wins on margin', async () => {
    const renewal: DecisionPrediction = {
      id: 'pr-renew',
      kind: 'renewal_probability',
      value: 0.8,
      predictedAt: new Date(NOW.getTime() + 3 * DAY),
      confidence: 0.7,
      reasons: [{ code: 'rule_defaults', base: 0.5, grantId: 'g1' }],
    };
    const input = decisionInputs([renewal, spike()], 3);
    expect(candidatesFor(input, NOW).map((c) => c.actionType)).toEqual(['renew', 'usage_alert']);

    const record = vi.fn(async (_s: unknown, c: { actionType: string }, o: { status: string; suppressedBy?: string }) => ({ id: `a-${c.actionType}`, actionType: c.actionType, ...o }));
    const pass = { verdict: vi.fn(async () => ({ pass: true })) };
    const pipeline = new DecisionPipeline(
      pass as never,
      pass as never,
      { inputs: vi.fn(async () => ({ openTicket: false, lastFailedPaymentAt: null })) } as never,
      pass as never,
      { peek: vi.fn(async () => ({ allowed: true })) } as never,
      { record } as never,
      { allowed: vi.fn(async () => true) } as never,
    );
    const mode = { engineRuns: true, actionTypes: ['renew', 'usage_alert'], confidenceThreshold: 0.6, holdoutPercent: 10 } as unknown as AiTenantMode;
    const out = await pipeline.decide({ tenantId: 't1', kind: 'user', id: 'u1' }, mode, { candidates: input, activeHours: new Array<number>(168).fill(0), quiet: null, pendingSends: [], stoppedToday: [] }, NOW);
    expect(out).toEqual([
      expect.objectContaining({ actionType: 'usage_alert', status: 'suppressed', suppressedBy: 'margin' }),
      expect.objectContaining({ actionType: 'renew', status: 'scheduled' }),
    ]);
  });

  it('is decided alone when nothing is for sale, though it has no margin to rank by', async () => {
    const record = vi.fn(async (_s: unknown, c: { actionType: string; expectedMargin?: unknown }, o: { status: string }) => ({ id: `a-${c.actionType}`, actionType: c.actionType, ...o }));
    const pass = { verdict: vi.fn(async () => ({ pass: true })) };
    const pipeline = new DecisionPipeline(
      pass as never,
      pass as never,
      { inputs: vi.fn(async () => ({ openTicket: false, lastFailedPaymentAt: null })) } as never,
      pass as never,
      { peek: vi.fn(async () => ({ allowed: true })) } as never,
      { record } as never,
      { allowed: vi.fn(async () => true) } as never,
    );
    const mode = { engineRuns: true, actionTypes: ['usage_alert'], confidenceThreshold: 0.6, holdoutPercent: 10 } as unknown as AiTenantMode;
    const out = await pipeline.decide({ tenantId: 't1', kind: 'user', id: 'u1' }, mode, { candidates: decisionInputs([spike()]), activeHours: new Array<number>(168).fill(0), quiet: null, pendingSends: [], stoppedToday: [] }, NOW);
    expect(out).toEqual([expect.objectContaining({ actionType: 'usage_alert', status: 'scheduled' })]);
    // No margin, so no currency (C-02): the audit row records none.
    expect(record.mock.calls[0][1].expectedMargin).toBeUndefined();
  });
});

describe('usage_alert delivery item (F-1516)', () => {
  it('carries the Grant and the numbers the message tells, and no plan', () => {
    const reasons = [...spike().reasons, { code: 'help_not_sale' }];
    const item = deliveryItem({
      id: 'a1',
      tenantId: 't1',
      subjectKind: 'user',
      subjectId: 'u1',
      actionType: 'usage_alert',
      status: 'scheduled',
      templateKey: 'suggestion.usage_alert',
      renderedBy: 'template',
      renderedText: null,
      deadline: new Date(anchor + DAY),
      reasons,
    });
    expect(item).toMatchObject({
      actionType: 'usage_alert',
      grantId: 'g1',
      variantId: null,
      price: null,
      usage: { meterKey: 'vpn.traffic', lastDayBytes: (BigInt(4) * GIB).toString(), usualDayBytes: GIB.toString(), factor: 4 },
    });
  });
});
