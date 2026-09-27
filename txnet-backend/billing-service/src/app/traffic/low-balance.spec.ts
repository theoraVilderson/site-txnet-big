/**
 * F-601-g — a metered Grant whose wallet buys less than {@link LOW_BALANCE_BYTES}
 * at its rate is told once per crossing; a balance back above re-arms it.
 */
import { Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { GIB } from './block-purchase';
import { LOW_BALANCE_BYTES, noticeLowBalance, type LowBalanceGrant } from './low-balance';

const NOW = new Date('2026-09-27T12:00:00Z');
const RATE = new Prisma.Decimal('0.5'); // $0.50 per GiB: $0.50 buys the threshold exactly

function grant(input: Partial<LowBalanceGrant> = {}): LowBalanceGrant {
  return { id: 'g1', tenantId: 't1', userId: 'u1', meteredRate: RATE, lowBalanceNoticeAt: null, ...input };
}

function fakeTx(matches = true) {
  const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
  const events: { type: string; aggregateId: string; payload: Record<string, unknown> }[] = [];
  const tx = {
    grant: {
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args);
        return { count: matches ? 1 : 0 };
      },
    },
    outboxEvent: {
      create: async ({ data }: { data: { type: string; aggregateId: string; payload: Record<string, unknown> } }) => {
        events.push(data);
        return { id: 'e1' };
      },
    },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, updates, events };
}

describe('noticeLowBalance', () => {
  it('the threshold is one GB at the Grant rate', () => {
    expect(LOW_BALANCE_BYTES).toBe(GIB);
  });

  it('tells a balance that buys less than the threshold, with what it still buys, and marks the crossing', async () => {
    const { tx, updates, events } = fakeTx();
    const outcome = await noticeLowBalance(tx, grant(), new Prisma.Decimal('0.40'), NOW);
    expect(outcome).toBe('told');
    expect(updates).toEqual([{ where: { id: 'g1', lowBalanceNoticeAt: null }, data: { lowBalanceNoticeAt: NOW } }]);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(OutboxEventType.GRANT_LOW_BALANCE);
    expect(events[0].aggregateId).toBe('g1');
    expect(events[0].payload).toEqual({ tenantId: 't1', userId: 'u1', grantId: 'g1', period: NOW.toISOString(), remaining: '819 MB' });
  });

  it('says nothing of a balance that still buys the threshold, and writes nothing when none was told', async () => {
    const { tx, updates, events } = fakeTx();
    expect(await noticeLowBalance(tx, grant(), new Prisma.Decimal('0.50'), NOW)).toBeNull();
    expect(updates).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('tells a crossing once: a Grant already told stays silent while the balance stays low', async () => {
    const { tx, updates, events } = fakeTx();
    const told = new Date('2026-09-27T09:00:00Z');
    expect(await noticeLowBalance(tx, grant({ lowBalanceNoticeAt: told }), new Prisma.Decimal('0.10'), NOW)).toBeNull();
    expect(updates).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('re-arms once the balance buys the threshold again, so the next crossing is a new period', async () => {
    const { tx, updates, events } = fakeTx();
    const told = new Date('2026-09-27T09:00:00Z');
    expect(await noticeLowBalance(tx, grant({ lowBalanceNoticeAt: told }), new Prisma.Decimal('5.00'), NOW)).toBe('rearmed');
    expect(updates).toEqual([{ where: { id: 'g1', lowBalanceNoticeAt: told }, data: { lowBalanceNoticeAt: null } }]);
    expect(events).toHaveLength(0);
  });

  it('emits nothing when another purchase marked the crossing first', async () => {
    const { tx, events } = fakeTx(false);
    expect(await noticeLowBalance(tx, grant(), new Prisma.Decimal('0.40'), NOW)).toBeNull();
    expect(events).toHaveLength(0);
  });

  it('never tells a Grant with no rate, nor a balance that buys nothing at all — that is the cutoff notice', async () => {
    const { tx, updates, events } = fakeTx();
    expect(await noticeLowBalance(tx, grant({ meteredRate: null }), new Prisma.Decimal('0.10'), NOW)).toBeNull();
    expect(await noticeLowBalance(tx, grant(), new Prisma.Decimal('0.00'), NOW)).toBeNull();
    expect(updates).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});
