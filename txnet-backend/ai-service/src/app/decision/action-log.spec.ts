import type { PrismaService } from '../prisma/prisma.service';
import { ActionLog, labelledMessage, SUGGESTION_LABEL } from './action-log';
import { TypeSwitch } from './type-switch';

/**
 * F-1509: every AI message is labelled and auditable, and a reseller can turn
 * any action type off completely — it is their brand.
 *
 * The failures worth a spec: a candidate stopped without a row (no audit of
 * what the engine wanted to say), a row with no reasons or a margin with no
 * currency, a message that reaches delivery without its label or its action
 * id, a type switched off while one of it is in flight or already queued and
 * still going out, and a switch that writes another tenant's setting.
 */

const T0 = new Date('2026-10-02T12:00:00Z');
const TENANT = '00000000-0000-4000-8000-000000000001';
const USER = '00000000-0000-4000-8000-000000000002';
const ADMIN = '00000000-0000-4000-8000-000000000003';
const subject = { tenantId: TENANT, kind: 'user' as const, id: USER };
const candidate = {
  actionType: 'renew' as const,
  confidence: 0.72,
  reasons: [{ code: 'grant_ends_soon', days: 3 }],
  templateKey: 'ai.renew.v1',
};

function fake(setting: unknown = null) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    aiSetting: { findUnique: vi.fn(async () => setting), upsert: vi.fn(async () => ({})) },
    aiAction: { create: vi.fn(async (a: { data: object }) => ({ id: 'a1', ...a.data })), updateMany: vi.fn(async () => ({ count: 2 })) },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  const p = prisma as unknown as PrismaService;
  return { log: new ActionLog(p), types: new TypeSwitch(p), tx };
}

describe('ActionLog.record (F-1509)', () => {
  it('records a stopped candidate with the step that stopped it', async () => {
    const { log, tx } = fake();
    await log.record(subject, candidate, { status: 'suppressed', suppressedBy: 'holdout' }, T0);
    expect(tx.aiAction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: TENANT, subjectKind: 'user', subjectId: USER, actionType: 'renew',
        status: 'suppressed', suppressedBy: 'holdout', reasons: candidate.reasons, templateKey: 'ai.renew.v1', renderedBy: 'template', createdAt: T0,
      }),
    });
  });

  it('records a scheduled one on its template, and model text as model', async () => {
    const { log, tx } = fake();
    await log.record(subject, candidate, { status: 'scheduled', scheduledFor: T0 }, T0);
    expect(tx.aiAction.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ status: 'scheduled', scheduledFor: T0, suppressedBy: null, renderedBy: 'template' }) });
    await log.record(subject, candidate, { status: 'awaiting_approval', renderedText: 'Renew now?' }, T0);
    expect(tx.aiAction.create).toHaveBeenLastCalledWith({ data: expect.objectContaining({ status: 'awaiting_approval', renderedBy: 'model', renderedText: 'Renew now?' }) });
  });

  it('stops a candidate whose type the tenant switched off while it was decided', async () => {
    const { log, tx } = fake({ disabledActionTypes: ['renew'] });
    await log.record(subject, candidate, { status: 'scheduled', scheduledFor: T0 }, T0);
    expect(tx.aiAction.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'suppressed', suppressedBy: 'type_disabled', scheduledFor: null }) });
  });

  it('refuses a candidate that cannot say why, or a margin with no currency (C-02)', async () => {
    const { log, tx } = fake();
    await expect(log.record(subject, { ...candidate, reasons: [] }, { status: 'suppressed', suppressedBy: 'cooldown' }, T0)).rejects.toThrow(/reasons/);
    await expect(
      log.record(subject, { ...candidate, expectedMargin: { amount: '1.50', currencyCode: '' } }, { status: 'suppressed', suppressedBy: 'cooldown' }, T0),
    ).rejects.toThrow(/currency/);
    expect(tx.aiAction.create).not.toHaveBeenCalled();
  });
});

describe('labelledMessage (F-1509)', () => {
  const action = { id: 'a1', tenantId: TENANT, subjectKind: 'user' as const, subjectId: USER, actionType: 'renew' as const, status: 'scheduled' as const, templateKey: 'ai.renew.v1', renderedBy: 'template' as const, renderedText: null };

  it('carries the suggestion label and the action id, for the tap and the audit', () => {
    expect(labelledMessage(action)).toEqual({
      actionId: 'a1', tenantId: TENANT, subjectKind: 'user', subjectId: USER, actionType: 'renew',
      label: SUGGESTION_LABEL, templateKey: 'ai.renew.v1', renderedBy: 'template', text: null,
    });
    expect(SUGGESTION_LABEL).toBe('suggestion');
  });

  it('builds nothing for an action that is not due to go out', () => {
    expect(() => labelledMessage({ ...action, status: 'suppressed' })).toThrow(/scheduled/);
  });
});

describe('TypeSwitch.set (F-1509)', () => {
  it('writes the tenant\'s own setting and stops whatever of the type is already queued', async () => {
    const { types, tx } = fake();
    await types.set(TENANT, ['renew', 'cross_sell'], ADMIN);
    expect(tx.aiSetting.upsert).toHaveBeenCalledWith({
      where: { tenantId: TENANT },
      create: { tenantId: TENANT, disabledActionTypes: ['renew', 'cross_sell'], updatedByUserId: ADMIN },
      update: { disabledActionTypes: ['renew', 'cross_sell'], updatedByUserId: ADMIN },
    });
    expect(tx.aiAction.updateMany).toHaveBeenCalledWith({
      where: { tenantId: TENANT, actionType: { in: ['renew', 'cross_sell'] }, status: { in: ['scheduled', 'awaiting_approval'] } },
      data: { status: 'suppressed', suppressedBy: 'type_disabled' },
    });
  });

  it('switching every type back on stops nothing', async () => {
    const { types, tx } = fake();
    await types.set(TENANT, [], ADMIN);
    expect(tx.aiAction.updateMany).not.toHaveBeenCalled();
  });
});
