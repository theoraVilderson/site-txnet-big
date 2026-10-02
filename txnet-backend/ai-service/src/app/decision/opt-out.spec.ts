import type { PrismaService } from '../prisma/prisma.service';
import { OptOuts } from './opt-out';
import { OptOutInternalController } from './opt-out-internal.controller';

/**
 * F-1505 / ADR-0109 point 8: one tap on "don't show me this again" silences
 * that action type for that subject, permanently, and the opt-out step drops
 * every later candidate of it.
 *
 * The failures worth a spec: a tap that stops nothing already queued (the
 * next message of the type still goes out), a tap on someone else's action
 * opting them out, a second tap failing instead of being a no-op, and the
 * step reading another subject's or another type's opt-out.
 */

const T0 = new Date('2026-10-02T12:00:00Z');
const subject = { tenantId: '00000000-0000-4000-8000-000000000001', kind: 'user' as const, id: '00000000-0000-4000-8000-000000000002' };
const ACTION_ID = '00000000-0000-4000-8000-0000000000a1';
const action = { id: ACTION_ID, tenantId: subject.tenantId, subjectKind: 'user', subjectId: subject.id, actionType: 'renew' };

function fake(found: unknown = action, optOut: unknown = null) {
  const tx = {
    $executeRaw: vi.fn(async () => 1),
    aiOptOut: { findUnique: vi.fn(async () => optOut), createMany: vi.fn(async () => ({ count: 1 })) },
    aiAction: { findFirst: vi.fn(async () => found), updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { optOuts: new OptOuts(prisma as unknown as PrismaService), tx };
}

describe('the opt-out step (F-1505)', () => {
  it('passes a type the subject never opted out of', async () => {
    const { optOuts } = fake();
    await expect(optOuts.verdict(subject, 'renew')).resolves.toEqual({ pass: true });
  });

  it('drops a type the subject opted out of', async () => {
    const { optOuts } = fake(action, { createdAt: T0 });
    await expect(optOuts.verdict(subject, 'renew')).resolves.toEqual({ pass: false, suppressedBy: 'opt_out' });
  });

  it('reads only this subject and this type', async () => {
    const { optOuts, tx } = fake();
    await optOuts.verdict(subject, 'resize_up');
    expect(tx.aiOptOut.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId_subjectKind_subjectId_actionType: { tenantId: subject.tenantId, subjectKind: 'user', subjectId: subject.id, actionType: 'resize_up' } },
      }),
    );
  });
});

describe('the one tap (F-1505)', () => {
  it('opts out of the tapped action’s type, and a second tap is a no-op', async () => {
    const { optOuts, tx } = fake();
    await expect(optOuts.optOutFrom(subject, ACTION_ID, T0)).resolves.toEqual({ actionType: 'renew' });
    expect(tx.aiOptOut.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: subject.tenantId, subjectKind: 'user', subjectId: subject.id, actionType: 'renew', createdAt: T0 }],
      skipDuplicates: true,
    });
  });

  it('finds the action only as this subject’s, so a tap on someone else’s writes nothing', async () => {
    const { optOuts, tx } = fake(null);
    await expect(optOuts.optOutFrom(subject, ACTION_ID, T0)).resolves.toBeNull();
    expect(tx.aiAction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ACTION_ID, tenantId: subject.tenantId, subjectKind: 'user', subjectId: subject.id } }),
    );
    expect(tx.aiOptOut.createMany).not.toHaveBeenCalled();
    expect(tx.aiAction.updateMany).not.toHaveBeenCalled();
  });

  it('dismisses the tapped message if it was still only sent', async () => {
    const { optOuts, tx } = fake();
    await optOuts.optOutFrom(subject, ACTION_ID, T0);
    expect(tx.aiAction.updateMany).toHaveBeenCalledWith({ where: { id: ACTION_ID, status: 'sent' }, data: { status: 'dismissed', outcomeAt: T0 } });
  });

  it('stops every message of the type still waiting to go out to this subject', async () => {
    const { optOuts, tx } = fake();
    await optOuts.optOutFrom(subject, ACTION_ID, T0);
    expect(tx.aiAction.updateMany).toHaveBeenCalledWith({
      where: { tenantId: subject.tenantId, subjectKind: 'user', subjectId: subject.id, actionType: 'renew', status: { in: ['scheduled', 'awaiting_approval'] } },
      data: { status: 'suppressed', suppressedBy: 'opt_out' },
    });
  });
});

describe('OptOutInternalController (F-1505)', () => {
  const body = { tenantId: subject.tenantId, subjectKind: 'user', subjectId: subject.id };

  it('answers the opted-out type for the caller’s own action', async () => {
    const { optOuts } = fake();
    await expect(new OptOutInternalController(optOuts).optOut(ACTION_ID, body)).resolves.toMatchObject({ data: { actionType: 'renew' } });
  });

  it('answers 404 when the action is not that subject’s', async () => {
    const { optOuts } = fake(null);
    await expect(new OptOutInternalController(optOuts).optOut(ACTION_ID, body)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a body that does not name a subject', async () => {
    const { optOuts } = fake();
    await expect(new OptOutInternalController(optOuts).optOut(ACTION_ID, { tenantId: subject.tenantId })).rejects.toMatchObject({ status: 400 });
  });
});
