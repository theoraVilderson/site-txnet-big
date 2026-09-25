import { EventEmitter } from 'events';
import type { NotificationClient } from '@txnet-backend/shared-core';
import { OUTBOX_READY_CHANNEL, OutboxRelayListener } from './outbox-relay.listener';
import type { OutboxRelayJob } from './outbox-relay.job';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * F-067-n (ADR-0084 decision 1): Postgres wakes the relay instead of the tick.
 *
 * What this must hold is the shape of the wake-up, because a burst is the
 * normal case: a thousand inserts are a thousand notifications, and each one
 * becoming a pass is a thousand `SKIP LOCKED` queries racing each other.
 * So: **at most one pass in flight and one queued behind it**, and a wake that
 * arrives while one is already queued is folded into it — the queued pass
 * reads the table after that insert committed, so it sees the row anyway.
 *
 * The other two are the ways a wake-up is lost silently: a notification sent
 * while nobody listened (so every connect runs a pass), and a pass that throws
 * taking the listener down with it (the next wake must still run).
 *
 * And the one it must not lose: a woken pass is still a run of `outbox_relay`,
 * so the worker's switch stops it like it stops the tick (invariant #1).
 */
class FakeClient extends EventEmitter implements NotificationClient {
  readonly calls: string[] = [];
  async connect() {
    this.calls.push('connect');
  }
  async query(sql: string) {
    this.calls.push(sql);
  }
  async end() {
    this.calls.push('end');
  }
}

function harness(isActive = true) {
  const client = new FakeClient();
  const prisma = { botWorker: { findUnique: vi.fn(async () => ({ isActive })) } };
  const gates: Array<() => void> = [];
  const relay = {
    key: 'outbox_relay',
    run: vi.fn(
      () =>
        new Promise((resolve) => {
          gates.push(() => resolve({ itemsProcessed: 0, errorsCount: 0 }));
        }),
    ),
  };
  const listener = new OutboxRelayListener(
    relay as unknown as OutboxRelayJob,
    prisma as unknown as PrismaService,
    () => client,
  );
  /** Let the pass in flight finish, then let the microtasks behind it settle. */
  const finishPass = async () => {
    gates.shift()?.();
    await new Promise((r) => setImmediate(r));
  };
  return { client, relay, prisma, listener, finishPass };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('OutboxRelayListener', () => {
  it('a wake does not run a relay an operator switched off (invariant #1)', async () => {
    const { relay, prisma, listener } = harness(false);
    await listener.handle('');
    expect(prisma.botWorker.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { key: 'outbox_relay' } }),
    );
    expect(relay.run).not.toHaveBeenCalled();
  });

  it('LISTENs on outbox_ready and runs one pass on connect, for what was inserted while nobody listened', async () => {
    const { client, relay, listener, finishPass } = harness();
    await Promise.race([listener.start(), new Promise((r) => setImmediate(r))]);

    expect(client.calls).toEqual(['connect', `LISTEN ${OUTBOX_READY_CHANNEL}`]);
    expect(OUTBOX_READY_CHANNEL).toBe('outbox_ready');
    expect(relay.run).toHaveBeenCalledTimes(1);
    await finishPass();
  });

  it('a burst while a pass runs becomes exactly one more pass, never one per notification', async () => {
    const { relay, listener, finishPass } = harness();

    void listener.handle('');
    await settle();
    expect(relay.run).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 50; i++) void listener.handle('');
    await settle();
    expect(relay.run).toHaveBeenCalledTimes(1); // still the one in flight

    await finishPass();
    expect(relay.run).toHaveBeenCalledTimes(2); // the one queued behind it

    await finishPass();
    expect(relay.run).toHaveBeenCalledTimes(2); // nothing more was owed
  });

  it('a wake after the queue drained starts a new pass', async () => {
    const { relay, listener, finishPass } = harness();
    void listener.handle('');
    await settle();
    await finishPass();
    void listener.handle('');
    await settle();
    expect(relay.run).toHaveBeenCalledTimes(2);
    await finishPass();
  });

  it('a pass that throws is logged, and the next wake still runs', async () => {
    const { relay, listener } = harness();
    relay.run.mockRejectedValueOnce(new Error('outbox relay stopped at event e1: unroutable'));

    await listener.handle('');
    relay.run.mockResolvedValueOnce({ itemsProcessed: 1, errorsCount: 0 });
    await listener.handle('');

    expect(relay.run).toHaveBeenCalledTimes(2);
  });
});
