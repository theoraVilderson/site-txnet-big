import type { PrismaService } from '../prisma/prisma.service';
import { cooldownVerdict, COOLDOWN_MS } from './cooldown';
import { CooldownReader } from './cooldown-reader';

/**
 * F-1504 / ADR-0109 point 8, D-12: once a subject has heard a suggestion of
 * one type, that type stays silent for 14 days — rolling from the send, and
 * only for that subject and that type.
 *
 * The failures worth a spec: a stopped or expired candidate starting a
 * cooldown (nothing was said, yet the type goes quiet), a second message of a
 * type queued while the first still waits to go out, and the window read by
 * calendar day or off by its boundary.
 */

const T0 = new Date('2026-10-02T12:00:00Z');
const daysAgo = (d: number) => new Date(T0.getTime() - d * 86_400_000);
const sent = (d: number) => ({ status: 'sent' as const, sentAt: daysAgo(d), createdAt: daysAgo(d) });

describe('the cooldown rule (F-1504)', () => {
  it('is 14 days', () => {
    expect(COOLDOWN_MS).toBe(14 * 86_400_000);
  });

  it('passes a type the subject never heard', () => {
    expect(cooldownVerdict([], T0)).toEqual({ pass: true });
  });

  it('holds a type sent 13 days ago and says when it reopens', () => {
    expect(cooldownVerdict([sent(13)], T0)).toEqual({ pass: false, suppressedBy: 'cooldown', retryAt: daysAgo(-1) });
  });

  it('reopens exactly 14 days after the send', () => {
    expect(cooldownVerdict([sent(14)], T0)).toEqual({ pass: true });
  });

  it('counts an accepted or dismissed one from when it was sent', () => {
    expect(cooldownVerdict([{ status: 'accepted', sentAt: daysAgo(3), createdAt: daysAgo(4) }], T0)).toMatchObject({ pass: false, retryAt: daysAgo(-11) });
    expect(cooldownVerdict([{ status: 'dismissed', sentAt: daysAgo(10), createdAt: daysAgo(10) }], T0)).toMatchObject({ pass: false });
  });

  it('holds while one of the type still waits to go out, with no reopening time yet', () => {
    expect(cooldownVerdict([{ status: 'scheduled', sentAt: null, createdAt: daysAgo(20) }], T0)).toEqual({ pass: false, suppressedBy: 'cooldown', retryAt: null });
    expect(cooldownVerdict([{ status: 'awaiting_approval', sentAt: null, createdAt: daysAgo(1) }], T0)).toMatchObject({ pass: false, retryAt: null });
  });

  it('ignores what was never said — suppressed or expired starts no cooldown', () => {
    expect(cooldownVerdict([{ status: 'suppressed', sentAt: null, createdAt: daysAgo(1) }, { status: 'expired', sentAt: null, createdAt: daysAgo(2) }], T0)).toEqual({ pass: true });
  });

  it('reopens at the latest send when there are several', () => {
    expect(cooldownVerdict([sent(12), sent(5)], T0)).toMatchObject({ retryAt: daysAgo(-9) });
  });
});

describe('CooldownReader (F-1504)', () => {
  const subject = { tenantId: '00000000-0000-4000-8000-000000000001', kind: 'user' as const, id: '00000000-0000-4000-8000-000000000002' };

  function fakeReader(rows: unknown[]) {
    const findMany = vi.fn(async () => rows);
    const tx = { $executeRaw: vi.fn(async () => 1), aiAction: { findMany } };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    return { reader: new CooldownReader(prisma as unknown as PrismaService), findMany };
  }

  it('reads only this subject and this type', async () => {
    const { reader, findMany } = fakeReader([]);
    await reader.verdict(subject, 'renew', T0);
    const [{ where }] = findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(where).toMatchObject({ tenantId: subject.tenantId, subjectKind: 'user', subjectId: subject.id, actionType: 'renew' });
  });

  it('answers with the rule over what it read', async () => {
    const { reader } = fakeReader([sent(2)]);
    await expect(reader.verdict(subject, 'renew', T0)).resolves.toMatchObject({ pass: false, suppressedBy: 'cooldown' });
  });
});
