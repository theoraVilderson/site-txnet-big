import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.service';
import { AiAdminSettings, settingsPatchSchema } from './ai-admin-settings';
import { AiManageGuard, AI_MANAGE_PERMISSION } from './ai-manage.guard';
import { AT_RISK_RENEWAL_BELOW, AtRisk } from './at-risk';
import { adminOfferSchema } from './ai-admin.controller';

/**
 * F-038-j1 (ADR-0109 points 7, 13; ADR-0110): the reseller's AI admin, on
 * `/api/ai/admin/*` behind the gate and `ai.manage`.
 *
 * The failures worth a spec: a caller without `ai.manage` through the door; a
 * tenant named by the body instead of the gate (one reseller writing
 * another's settings or reading its customers); a threshold or holdout share
 * the schema would reject arriving as a 500, or a holdout of 0 — no
 * measurement; the engine switched off while suggestions are still queued and
 * going out; a type switched off past `TypeSwitch` (queued ones still sent);
 * an at-risk list that shows a safe renewal, another tenant's, or a run-out
 * weeks away.
 */

const TENANT = '00000000-0000-4000-8000-0000000000a1';
const ADMIN = '00000000-0000-4000-8000-0000000000a3';
const NOW = new Date('2026-10-02T12:00:00Z');
const DAY = 86_400_000;

const ctx = (permissions: string[]) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ identity: { userId: ADMIN, tenantId: TENANT, roleId: 'r', sessionId: 's', permissions } }) }) }) as never;

describe('the door (F-038-j1)', () => {
  it('lets through ai.manage and *, nothing else', () => {
    const guard = new AiManageGuard();
    expect(AI_MANAGE_PERMISSION).toBe('ai.manage');
    expect(guard.canActivate(ctx(['ai.manage']))).toBe(true);
    expect(guard.canActivate(ctx(['*']))).toBe(true);
    expect(() => guard.canActivate(ctx(['coupon.manage']))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx([]))).toThrow(ForbiddenException);
  });
});

describe('bodies name no tenant (F-038-j1)', () => {
  it('a settings patch or an offer that names a tenant or a user is refused, never obeyed', () => {
    expect(settingsPatchSchema.safeParse({ engineEnabled: false }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ tenantId: TENANT, engineEnabled: false }).success).toBe(false);
    const offer = { name: 'Stay', actionType: 'retain_offer', couponTemplateId: '00000000-0000-4000-8000-0000000000c1', maxDiscountPercent: '20', dailyBudget: '100', currencyCode: 'IRR' };
    expect(adminOfferSchema.safeParse(offer).success).toBe(true);
    expect(adminOfferSchema.safeParse({ ...offer, tenantId: TENANT }).success).toBe(false);
    expect(adminOfferSchema.safeParse({ ...offer, createdByUserId: ADMIN }).success).toBe(false);
  });

  it('a threshold in [0, 1] at two places and a holdout share of 5–20 — never 0', () => {
    for (const confidenceThreshold of ['0', '0.6', '1', '0.75']) expect(settingsPatchSchema.safeParse({ confidenceThreshold }).success).toBe(true);
    for (const confidenceThreshold of ['1.01', '-0.1', '0.605', 0.6]) expect(settingsPatchSchema.safeParse({ confidenceThreshold }).success).toBe(false);
    for (const holdoutPercent of [5, 10, 20]) expect(settingsPatchSchema.safeParse({ holdoutPercent }).success).toBe(true);
    for (const holdoutPercent of [0, 4, 21, 10.5]) expect(settingsPatchSchema.safeParse({ holdoutPercent }).success).toBe(false);
  });
});

function settingsFake(row: unknown = null) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    aiSetting: { findUnique: vi.fn(async () => row), upsert: vi.fn(async () => ({})) },
    aiAction: { updateMany: vi.fn(async () => ({ count: 3 })) },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService;
  const types = { set: vi.fn(async () => undefined) };
  const policy = { forTenant: vi.fn(async () => ({ engineRuns: true, actionTypes: ['renew'], languageLayer: 'off', modelText: {}, confidenceThreshold: 0.6, holdoutPercent: 10 })) };
  return { settings: new AiAdminSettings(prisma, types as never, policy as never), tx, types, policy };
}

describe('AiAdminSettings (F-038-j1)', () => {
  it('reads the defaults for a tenant with no row, and whether the engine actually runs', async () => {
    const { settings } = settingsFake();
    expect(await settings.read(TENANT)).toMatchObject({
      engineEnabled: true, engineRuns: true, confidenceThreshold: '0.60', holdoutPercent: 10, disabledActionTypes: [],
      actionTypes: expect.arrayContaining(['renew', 'top_up_wallet', 'retain_offer']),
    });
  });

  it('writes the gate’s tenant and who changed it, and goes through TypeSwitch for the type list', async () => {
    const { settings, tx, types } = settingsFake();
    await settings.write(TENANT, ADMIN, settingsPatchSchema.parse({ confidenceThreshold: '0.7', holdoutPercent: 15, disabledActionTypes: ['retain_offer'] }));
    expect(tx.aiSetting.upsert).toHaveBeenCalledWith({
      where: { tenantId: TENANT },
      create: { tenantId: TENANT, confidenceThreshold: new Prisma.Decimal('0.7'), holdoutPercent: 15, updatedByUserId: ADMIN },
      update: { confidenceThreshold: new Prisma.Decimal('0.7'), holdoutPercent: 15, updatedByUserId: ADMIN },
    });
    expect(types.set).toHaveBeenCalledWith(TENANT, ['retain_offer'], ADMIN);
    expect(tx.aiAction.updateMany).not.toHaveBeenCalled();
  });

  it('switching the engine off stops every suggestion still queued — none goes out after', async () => {
    const { settings, tx } = settingsFake();
    await settings.write(TENANT, ADMIN, settingsPatchSchema.parse({ engineEnabled: false }));
    expect(tx.aiAction.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, status: { in: ['scheduled', 'awaiting_approval'] } },
      data: { status: 'suppressed', suppressedBy: 'engine_disabled' },
    });
  });
});

describe('AtRisk (F-038-j1)', () => {
  const prediction = (over: Record<string, unknown>) => ({
    id: 'p1', subjectId: 'u1', kind: 'renewal_probability', value: new Prisma.Decimal('0.3'), currencyCode: null,
    predictedAt: new Date(NOW.getTime() + 5 * DAY), confidence: new Prisma.Decimal('0.7'), reasons: [{ code: 'rule_defaults', grantId: 'g1' }], ...over,
  });
  function fake(rows: unknown[]) {
    const tx = { $executeRaw: vi.fn(async () => 1), aiPrediction: { findMany: vi.fn(async () => rows) } };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as unknown as PrismaService;
    return { atRisk: new AtRisk(prisma), tx };
  }

  it('may not renew: only below 0.5, the tenant’s own, soonest first, with the reasons', async () => {
    const { atRisk, tx } = fake([prediction({})]);
    const page = await atRisk.list(TENANT, 'renewal', null, 50, NOW);
    expect(AT_RISK_RENEWAL_BELOW).toBe(0.5);
    expect(tx.aiPrediction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: TENANT, subjectKind: 'user', kind: 'renewal_probability', value: { lt: 0.5 }, predictedAt: { gt: NOW } },
      orderBy: [{ predictedAt: 'asc' }, { id: 'asc' }],
      take: 51,
    }));
    expect(page).toEqual({
      items: [{ userId: 'u1', grantId: 'g1', value: '0.3000', predictedAt: new Date(NOW.getTime() + 5 * DAY).toISOString(), confidence: '0.7000', reasons: [{ code: 'rule_defaults', grantId: 'g1' }] }],
      nextCursor: null,
    });
  });

  it('will run out: only inside the lead time', async () => {
    const { atRisk, tx } = fake([]);
    await atRisk.list(TENANT, 'run_out', null, 50, NOW);
    expect(tx.aiPrediction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: TENANT, subjectKind: 'user', kind: 'meter_exhaustion', predictedAt: { gt: NOW, lte: new Date(NOW.getTime() + 7 * DAY) } },
    }));
  });

  it('pages with a cursor: one more row read than shown says there is a next page', async () => {
    const rows = [prediction({ id: 'p1' }), prediction({ id: 'p2' }), prediction({ id: 'p3' })];
    const { atRisk, tx } = fake(rows);
    const page = await atRisk.list(TENANT, 'renewal', 'p0', 2, NOW);
    expect(tx.aiPrediction.findMany).toHaveBeenCalledWith(expect.objectContaining({ cursor: { id: 'p0' }, skip: 1, take: 3 }));
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe('p2');
  });
});
