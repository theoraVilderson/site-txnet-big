import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Prisma } from '@prisma/client';

import type { AiTenantMode } from '../policy/ai-defaults';
import type { CandidateInputs, OfferOption, PlanOption } from './candidates';
import { OFFER_GIVEN } from './offer-guardrail';
import { DecisionPipeline, type SubjectDecisionInputs } from './pipeline';

/**
 * F-038-q / ADR-0109 point 9: an offer goes to one account once, and the
 * database holds that, not only the guardrail's read. Two runs that both read
 * "not given yet" — an hourly rebuild racing a manual one — would otherwise
 * both queue the same discount.
 *
 * The failures worth a spec: the index missing or covering other statuses
 * than the guardrail counts as given (a stopped row blocking a later offer,
 * or a told one not blocking); and the losing run crashing instead of
 * recording the candidate as stopped by `offer_guardrail`.
 */

const MIGRATIONS = join(__dirname, '../../../../prisma/domains/migrations');
const sql = readdirSync(MIGRATIONS)
  .filter((m) => !m.endsWith('.toml'))
  .map((m) => readFileSync(join(MIGRATIONS, m, 'migration.sql'), 'utf8'))
  .join('\n')
  .replace(/--[^\n]*/g, '');

describe('one offer per account, in the database (F-038-q)', () => {
  const index = /CREATE UNIQUE INDEX "action_offer_once" ON "ai"\."action" \(([^)]*)\) WHERE ([^;]*);/.exec(sql);

  it('is a unique index over the account and the offer', () => {
    expect(index).not.toBeNull();
    expect(index?.[1]).toBe('"tenantId", "subjectKind", "subjectId", "offerId"');
  });

  it('counts exactly the statuses the guardrail counts as given', () => {
    const where = index?.[2] ?? '';
    expect(where).toMatch(/"offerId" IS NOT NULL/);
    const listed = /"status" IN \(([^)]*)\)/.exec(where)?.[1].split(',').map((s) => s.trim().replace(/'/g, '')) ?? [];
    expect([...listed].sort()).toEqual([...OFFER_GIVEN].sort());
  });
});

describe('the run that loses the race (F-038-q)', () => {
  const TENANT = '00000000-0000-4000-8000-0000000000aa';
  const USER = '00000000-0000-4000-8000-000000000001';
  const GRANT = '00000000-0000-4000-8000-0000000000b1';
  const NOW = new Date('2026-10-05T09:20:00Z');
  const DAY = 86_400_000;
  const subject = { tenantId: TENANT, kind: 'user' as const, id: USER };
  const MODE: AiTenantMode = {
    engineRuns: true,
    actionTypes: ['renew', 'retain_offer'],
    languageLayer: 'off',
    modelText: {},
    confidenceThreshold: 0.6,
    holdoutPercent: 10,
  };
  const plan: PlanOption = {
    variantId: 'v50', productId: 'p1', billingMode: 'prepaid', durationDays: 30,
    size: BigInt(50) * BigInt(1024 ** 3), price: { amount: new Prisma.Decimal('200000'), currencyCode: 'IRR' },
  };
  const offer: OfferOption = { id: 'of-1', variantId: 'v50', template: null, maxDiscountPercent: new Prisma.Decimal('20'), currencyCode: 'IRR', places: 0 };
  const candidates: CandidateInputs = {
    predictions: [{ id: 'pr', kind: 'renewal_probability', value: 0.3, predictedAt: null, confidence: 0.7, reasons: [{ code: 'rule_defaults', grantId: GRANT }] }],
    grants: new Map([[GRANT, { id: GRANT, variantId: 'v50', endsAt: new Date(NOW.getTime() + 3 * DAY) }]]),
    plans: new Map([['v50', plan]]),
    offers: [offer],
    usedOfferIds: new Set(),
  };
  const decisionInputs: SubjectDecisionInputs = {
    candidates, activeHours: new Array<number>(168).fill(0), quiet: null, pendingSends: [], stoppedToday: [],
  };

  function harness(scheduledWrite: () => Promise<unknown>) {
    const pass = { verdict: vi.fn(async () => ({ pass: true })) };
    const log = {
      record: vi.fn(async (_s: unknown, c: { actionType: string }, o: { status: string }) =>
        (o.status === 'scheduled' ? scheduledWrite() : { id: `a-${c.actionType}`, actionType: c.actionType, ...o })),
    };
    const pipeline = new DecisionPipeline(
      pass as never,
      pass as never,
      { inputs: vi.fn(async () => ({ openTicket: false, lastFailedPaymentAt: null })) } as never,
      pass as never,
      { peek: vi.fn(async () => ({ allowed: true })) } as never,
      log as never,
      { allowed: vi.fn(async () => true) } as never,
    );
    return { pipeline, log };
  }

  const taken = () => new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002', clientVersion: 'test', meta: { target: 'action_offer_once' },
  });

  it('records the offer as stopped by the guardrail when the database says it was given meanwhile', async () => {
    const { pipeline, log } = harness(async () => { throw taken(); });
    const out = await pipeline.decide(subject, MODE, decisionInputs, NOW);
    expect(log.record).toHaveBeenLastCalledWith(subject, expect.objectContaining({ actionType: 'retain_offer', offerId: 'of-1' }), { status: 'suppressed', suppressedBy: 'offer_guardrail' }, NOW);
    expect(out).toEqual([expect.objectContaining({ actionType: 'retain_offer', status: 'suppressed', suppressedBy: 'offer_guardrail' })]);
  });

  it('still fails on any other write error', async () => {
    const { pipeline } = harness(async () => { throw new Error('connection lost'); });
    await expect(pipeline.decide(subject, MODE, decisionInputs, NOW)).rejects.toThrow('connection lost');
  });
});
