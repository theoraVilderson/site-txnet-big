/**
 * Telling a person their access moved (AC-1-s) — the notice half of
 * `identity.access.changed` (AC-1-q); the live half is `LivePushConsumer`'s.
 *
 * What would break silently here, and nowhere else:
 *  - each cause is its own template, and what it names (the role, the keys
 *    given and taken) reaches auth-service as params — the words are its;
 *  - a role edit that moved none of this holder's keys tells no one;
 *  - nothing is pushed live from here: the page already re-read on the
 *    live-push consumer's `{type}`, and a second frame would be a second read;
 *  - a cause with no template, or a payload without its person, dead-letters
 *    instead of being dropped.
 */
import { UnscopedRedisKeys, type OutboxMessage } from '@txnet-backend/shared-core';

import { AccessNoticeConsumer } from './access-notice.consumer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const EVENT = '99999999-9999-4999-8999-999999999999';

function event(payload: Record<string, unknown>): OutboxMessage {
  return {
    id: EVENT,
    aggregate: 'identity.access',
    aggregateId: USER,
    type: 'identity.access.changed',
    occurredAt: '2026-10-09T10:00:00Z',
    payload: { tenantId: TENANT, userId: USER, ...payload },
  };
}

function build() {
  const calls = {
    set: [] as string[],
    published: [] as unknown[],
    joined: [] as Array<{ burst: string; params: unknown }>,
  };
  const redis = {
    setNx: vi.fn(async (key: string) => {
      calls.set.push(key);
      return true;
    }),
    del: vi.fn(),
    present: vi.fn(async (keys: string[]) => keys.map(() => false)),
    evalScript: vi.fn(async (_script: string, keys: string[], args: unknown[]) => {
      calls.joined.push({ burst: keys[0]!, params: JSON.parse(String(args[1])).params });
      return 1;
    }),
  };
  const realtime = { publish: vi.fn(async (...a: unknown[]) => void calls.published.push(a)) };
  const broker = { consumeAccessNotices: vi.fn(), publishNoticeFlush: vi.fn(async () => {}) };
  const config = { get: (_key: string, fallback?: unknown) => fallback };
  const consumer = new AccessNoticeConsumer(broker as never, redis as never, realtime as never, config as never);
  return { consumer, calls };
}

const burst = (template: string) => UnscopedRedisKeys.noticeBurst(TENANT, USER, template);

describe('AccessNoticeConsumer.handle', () => {
  it('a role set tells the person their role now, by name, and pushes nothing live', async () => {
    const { consumer, calls } = build();
    await consumer.handle(event({ cause: 'role_set', role: 'Support lead' }));

    expect(calls.joined).toEqual([{ burst: burst('accessRoleSet'), params: { role: 'Support lead' } }]);
    expect(calls.set).toEqual([UnscopedRedisKeys.outboxProcessed('access-notice:person', EVENT)]);
    expect(calls.published).toEqual([]);
  });

  it('a role edit tells each holder the keys given and taken, as keys — auth-service names them', async () => {
    const { consumer, calls } = build();
    await consumer.handle(event({ cause: 'role_edited', given: ['coupon.manage', 'catalog.manage'], taken: ['user.ban'] }));

    expect(calls.joined).toEqual([
      { burst: burst('accessKeysChanged'), params: { given: 'coupon.manage,catalog.manage', taken: 'user.ban' } },
    ]);
  });

  it('an ended membership tells the person the group, by name, and what they lost (GR-1-c)', async () => {
    const { consumer, calls } = build();
    await consumer.handle(event({ cause: 'group_membership_ended', group: 'Support', given: [], taken: ['user.read'] }));

    expect(calls.joined).toEqual([{ burst: burst('accessMembershipEnded'), params: { group: 'Support', taken: 'user.read' } }]);
  });

  it('a key window opening or closing tells what moved (F-030-a)', async () => {
    const { consumer, calls } = build();
    await consumer.handle(event({ cause: 'key_window', given: ['report.read'], taken: [] }));

    expect(calls.joined).toEqual([{ burst: burst('accessKeyWindow'), params: { given: 'report.read' } }]);
  });

  it('an ended membership without its group dead-letters', async () => {
    const { consumer } = build();
    await expect(consumer.handle(event({ cause: 'group_membership_ended', taken: ['user.read'] }))).rejects.toThrow('without naming the group');
  });

  it('only what moved is named: a key only given has no `taken`', async () => {
    const { consumer, calls } = build();
    await consumer.handle(event({ cause: 'role_edited', given: ['coupon.manage'], taken: [] }));

    expect(calls.joined).toEqual([{ burst: burst('accessKeysChanged'), params: { given: 'coupon.manage' } }]);
  });

  it.each(['keys_set', 'group_access'])('%s (AC-1-l, AC-1-m) is told the same way, and only when it moved a key', async (cause) => {
    const { consumer, calls } = build();
    await consumer.handle(event({ cause, given: [], taken: ['user.write'] }));
    await consumer.handle(event({ cause, given: [], taken: [] }));

    expect(calls.joined).toEqual([{ burst: burst('accessKeysChanged'), params: { taken: 'user.write' } }]);
  });

  it('a role edit that moved no key of theirs tells no one', async () => {
    const { consumer, calls } = build();
    await consumer.handle(event({ cause: 'role_edited', given: [], taken: [] }));
    await consumer.handle(event({ cause: 'role_edited' }));

    expect(calls.joined).toEqual([]);
    expect(calls.set).toEqual([]);
  });

  it.each([
    ['seat_removed', 'accessSeatRemoved'],
    ['seat_restored', 'accessSeatRestored'],
  ])('%s is told as %s', async (cause, template) => {
    const { consumer, calls } = build();
    await consumer.handle(event({ cause }));

    expect(calls.joined).toEqual([{ burst: burst(template), params: {} }]);
  });

  it('a cause with no template dead-letters rather than being dropped', async () => {
    const { consumer, calls } = build();
    await expect(consumer.handle(event({ cause: 'window_opened' }))).rejects.toThrow(/cause/);
    expect(calls.set).toEqual([]);
  });

  it('a role set that does not name its role dead-letters', async () => {
    const { consumer } = build();
    await expect(consumer.handle(event({ cause: 'role_set' }))).rejects.toThrow(/role/);
  });

  it('a payload without its person dead-letters rather than guessing whose it is', async () => {
    const { consumer } = build();
    await expect(consumer.handle(event({ cause: 'seat_removed', userId: undefined }))).rejects.toThrow(/payload/);
  });
});
