import type { AiReaderPrisma } from '../prisma/prisma.service';
import { QUIET_AFTER_FAILED_PAYMENT_MS, quietDownVerdict } from './quiet-down';
import { QuietDownReader } from './quiet-down-reader';

/**
 * F-1506 / ADR-0109 point 8: no pitch in the middle of a problem. A subject
 * with an open ticket hears nothing proactive; for 72 hours after a failed
 * payment only `checkout_help` may speak — the one message about that
 * problem. Outage and connection drop need network data the engine may not
 * read (point 6) and are not rules here.
 *
 * The failures worth a spec: a renewal pitched the hour a payment failed,
 * `checkout_help` silenced by the very failure it exists for, the window
 * reopening early or never, and a closed ticket still holding everything.
 */

const T0 = new Date('2026-10-02T12:00:00Z');
const hoursAgo = (h: number) => new Date(T0.getTime() - h * 3_600_000);
const calm = { openTicket: false, lastFailedPaymentAt: null };

describe('the quiet-down rule (F-1506)', () => {
  it('waits 72 hours after a failed payment', () => {
    expect(QUIET_AFTER_FAILED_PAYMENT_MS).toBe(72 * 3_600_000);
  });

  it('passes a subject with no problem', () => {
    expect(quietDownVerdict(calm, 'renew', T0)).toEqual({ pass: true });
  });

  it('holds every type while a ticket is open, with no reopening time', () => {
    for (const type of ['renew', 'resize_up', 'checkout_help'] as const) {
      expect(quietDownVerdict({ ...calm, openTicket: true }, type, T0)).toEqual({ pass: false, suppressedBy: 'quiet_down', retryAt: null });
    }
  });

  it('holds a pitch for 72 hours after a failed payment and says when it reopens', () => {
    expect(quietDownVerdict({ ...calm, lastFailedPaymentAt: hoursAgo(2) }, 'renew', T0)).toEqual({
      pass: false,
      suppressedBy: 'quiet_down',
      retryAt: hoursAgo(-70),
    });
  });

  it('reopens exactly 72 hours after the failure', () => {
    expect(quietDownVerdict({ ...calm, lastFailedPaymentAt: hoursAgo(72) }, 'renew', T0)).toEqual({ pass: true });
  });

  it('lets checkout_help through after a failed payment — it is the help for that failure', () => {
    expect(quietDownVerdict({ ...calm, lastFailedPaymentAt: hoursAgo(1) }, 'checkout_help', T0)).toEqual({ pass: true });
  });
});

describe('QuietDownReader (F-1506)', () => {
  const user = { tenantId: '00000000-0000-4000-8000-000000000001', kind: 'user' as const, id: '00000000-0000-4000-8000-000000000002' };

  function fakeReader(tickets: unknown[], failed: unknown) {
    const queryRaw = vi.fn(async () => tickets);
    const findFirst = vi.fn(async () => failed);
    const tx = { $executeRaw: vi.fn(async () => 1), $queryRaw: queryRaw, paymentTransaction: { findFirst } };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    return { reader: new QuietDownReader(prisma as unknown as AiReaderPrisma), queryRaw, findFirst };
  }

  it('reads an open ticket and this user’s latest failed payment inside the window', async () => {
    const { reader, findFirst } = fakeReader([{ one: 1 }], { createdAt: hoursAgo(5) });
    await expect(reader.inputs(user, T0)).resolves.toEqual({ openTicket: true, lastFailedPaymentAt: hoursAgo(5) });
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: user.id, status: 'failed', createdAt: { gt: hoursAgo(72) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
  });

  it('answers calm when neither is there', async () => {
    const { reader } = fakeReader([], null);
    await expect(reader.inputs(user, T0)).resolves.toEqual(calm);
  });

  it('reads nothing for a reseller subject — its tickets and payments are not a user’s (F-038-o)', async () => {
    const { reader, queryRaw, findFirst } = fakeReader([{ one: 1 }], { createdAt: T0 });
    await expect(reader.inputs({ ...user, kind: 'tenant' }, T0)).resolves.toEqual(calm);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
