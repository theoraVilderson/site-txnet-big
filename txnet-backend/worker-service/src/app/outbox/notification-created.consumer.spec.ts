/**
 * A new notification reaching an open panel (F-035-b) — the outbox's third
 * consumer, on the first one's dedupe rule (ADR-0045).
 *
 * What would break silently here, and nowhere else:
 *  - **whose socket.** The event goes to the owner's own `user:` channel and no
 *    other; a wrong channel is a stranger's toast with no error anywhere;
 *  - **delivery is at-least-once**: a redelivered event must not pop the same
 *    item into the dropdown twice, and its marker is its own consumer's;
 *  - a payload that does not say whose row it is is refused, never guessed.
 */
import { OutboxEventType, UnscopedRedisKeys, type OutboxMessage } from '@txnet-backend/shared-core';

import { NotificationCreatedConsumer } from './notification-created.consumer';

const USER = '44444444-4444-4444-8444-444444444444';
const NOTIFICATION = '66666666-6666-4666-8666-666666666666';
const EVENT = '99999999-9999-4999-8999-999999999999';

const ITEM = {
  id: NOTIFICATION,
  type: 'system_alert',
  title: 'Maintenance',
  body: 'Tonight 02:00–03:00',
  readAt: null,
  createdAt: '2026-09-17T10:00:00.000Z',
};

function event(payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    id: EVENT,
    aggregate: 'notification.notification',
    aggregateId: NOTIFICATION,
    type: 'notification.created',
    occurredAt: '2026-09-17T10:00:00Z',
    payload: { userId: USER, notification: ITEM, ...payload },
  };
}

function build({ marked = false }: { marked?: boolean } = {}) {
  const calls = { set: [] as unknown[][], published: [] as Array<{ channel: string; payload: unknown }> };
  const redis = {
    setNx: vi.fn(async (...args: unknown[]) => {
      calls.set.push(args);
      return !marked;
    }),
  };
  const realtime = {
    publish: vi.fn(async (channel: string, payload: unknown) => {
      calls.published.push({ channel, payload });
    }),
  };
  const broker = { consumeNotificationCreated: vi.fn() };
  const consumer = new NotificationCreatedConsumer(broker as never, redis as never, realtime as never);
  return { consumer, calls };
}

describe('NotificationCreatedConsumer.handle', () => {
  it('marks the event under its own consumer and pushes the item to its owner\'s channel', async () => {
    const { consumer, calls } = build();

    await consumer.handle(event());

    expect(calls.set).toEqual([[UnscopedRedisKeys.outboxProcessed('notification-created-live', EVENT), expect.any(Number)]]);
    expect(calls.published).toEqual([
      { channel: `user:${USER}`, payload: { type: OutboxEventType.NOTIFICATION_CREATED, notification: ITEM } },
    ]);
  });

  it('does nothing for an event it already handled', async () => {
    const { consumer, calls } = build({ marked: true });

    await consumer.handle(event());

    expect(calls.published).toEqual([]);
  });

  it('refuses a payload without its user or item, rather than guessing whose it is', async () => {
    const { consumer, calls } = build();

    await expect(consumer.handle(event({ userId: undefined }))).rejects.toThrow(/payload/);
    await expect(consumer.handle(event({ notification: { title: 'no id' } }))).rejects.toThrow(/payload/);
    expect(calls.set).toEqual([]);
    expect(calls.published).toEqual([]);
  });
});
