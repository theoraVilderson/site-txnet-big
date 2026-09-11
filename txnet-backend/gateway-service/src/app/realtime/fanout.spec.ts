import { decodeRealtimeFanout } from '@txnet-backend/shared-core';
import { RedisKeys } from '../redis/redis.keys';
import { ConnectionRegistry, type Connection } from './connection.registry';
import { RealtimeFanout } from './fanout';

/**
 * The invariant this item turns on: **an event reaches the sockets holding
 * that channel on this replica, and nothing else.**
 *
 * It earns the one spec the item is budgeted (`CODE-LAYOUT.md`) because every
 * way it breaks is silent. A channel this replica forgot to subscribe to
 * delivers nothing and reports nothing. A channel it forgot to unsubscribe
 * from leaks a Redis subscription per name a client can invent. A wire name
 * that disagrees with the producer's by one prefix publishes happily into a
 * channel nobody is listening on — and ioredis makes that the *default*,
 * because it does not apply `keyPrefix` to `PUBLISH` or `SUBSCRIBE`.
 *
 * Nothing here asserts that a mock was called with what it was just handed.
 * The fake Redis is a real, if tiny, pub/sub bus: the test publishes and
 * asserts what came out of the sockets.
 */

const KEY_PREFIX = 'txnet:auth:v3:';

/** A pub/sub bus small enough to reason about, honest about what it routes. */
class FakeSubscriber {
  readonly subscribed = new Set<string>();
  private handler?: (channel: string, raw: string) => void;

  on(event: 'message', handler: (channel: string, raw: string) => void): this {
    if (event === 'message') this.handler = handler;
    return this;
  }

  async subscribe(channel: string): Promise<void> {
    this.subscribed.add(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscribed.delete(channel);
  }

  /** What Redis does: deliver only to a channel that was actually subscribed. */
  publish(channel: string, raw: string): void {
    if (this.subscribed.has(channel)) this.handler?.(channel, raw);
  }

  quit(): Promise<void> {
    return Promise.resolve();
  }
}

/** A connection whose socket records what was written to it. */
function fakeConnection(id: string, userId: string) {
  const sent: string[] = [];
  const connection: Connection = {
    id,
    identity: { userId, tenantId: 'tenant-1', sessionId: `sess-${id}`, permissions: [] },
    address: '203.0.113.1',
    socket: { readyState: 1, send: (frame: string) => sent.push(frame) } as never,
    subscriptions: new Set<string>(),
    alive: true,
  };
  return { connection, sent };
}

function harness() {
  const subscriber = new FakeSubscriber();
  const registry = new ConnectionRegistry();
  const fanout = new RealtimeFanout(registry, {
    keyPrefix: KEY_PREFIX,
    subscriber: subscriber as never,
  });
  fanout.listen();
  return { subscriber, registry, fanout };
}

/** Subscribe a connection the way the gateway does, then settle the fan-out. */
async function join(
  h: ReturnType<typeof harness>,
  connection: Connection,
  channel: string,
): Promise<void> {
  h.registry.add(connection);
  h.registry.subscribe(connection, channel);
  await h.fanout.reconcile(channel);
}

describe('realtime fan-out', () => {
  describe('the wire name', () => {
    // The producer builds this name in `worker-service`'s own `redis.keys.ts`
    // from the same shared prefix. If the two ever disagree, publishing
    // succeeds, delivery stops, and no error is raised anywhere.
    it('is the shared prefix, the fan-out prefix and the channel', () => {
      expect(RedisKeys.realtimeFanout('user:user-1')).toBe('realtime:user:user-1');
    });

    // ioredis does not prepend `keyPrefix` to a pub/sub channel — Redis does
    // not count it as a key — so this side has to do it explicitly.
    it('carries the keyspace prefix, which ioredis will not add', async () => {
      const h = harness();
      const { connection } = fakeConnection('c1', 'user-1');
      await join(h, connection, 'user:user-1');

      expect([...h.subscriber.subscribed]).toEqual([
        `${KEY_PREFIX}realtime:user:user-1`,
      ]);
    });
  });

  describe('delivery', () => {
    it('reaches the connections holding that channel', async () => {
      const h = harness();
      const a = fakeConnection('c1', 'user-1');
      const b = fakeConnection('c2', 'user-1');
      await join(h, a.connection, 'user:user-1');
      await join(h, b.connection, 'user:user-1');

      h.subscriber.publish(
        `${KEY_PREFIX}realtime:user:user-1`,
        JSON.stringify({ payload: { otp: 'delivered' } }),
      );

      for (const socket of [a.sent, b.sent]) {
        expect(socket).toHaveLength(1);
        expect(JSON.parse(socket[0])).toEqual({
          type: 'message',
          channel: 'user:user-1',
          payload: { otp: 'delivered' },
        });
      }
    });

    // The whole point of the item. Two connections on one replica, each on its
    // own channel: an event for one must not reach the other, and the
    // authorization that put them on different channels is `channel.ts`'s —
    // the fan-out never re-decides it, it only routes by the name.
    it("never reaches a connection that does not hold the channel", async () => {
      const h = harness();
      const mine = fakeConnection('c1', 'user-1');
      const theirs = fakeConnection('c2', 'user-2');
      await join(h, mine.connection, 'user:user-1');
      await join(h, theirs.connection, 'user:user-2');

      h.subscriber.publish(
        `${KEY_PREFIX}realtime:user:user-1`,
        JSON.stringify({ payload: 'mine' }),
      );

      expect(mine.sent).toHaveLength(1);
      expect(theirs.sent).toEqual([]);
    });

    // A shared Redis is writable by anything on the platform. A body that is
    // not an envelope is dropped; a throw inside a pub/sub listener has no
    // caller and would take every socket on the replica with it.
    it.each([
      ['not JSON', 'nonsense{'],
      ['a bare value', '"just a string"'],
      ['an array', '[1,2,3]'],
      ['an object with no payload key', '{"data":1}'],
    ])('drops a body that is %s', async (_label, raw) => {
      const h = harness();
      const { connection, sent } = fakeConnection('c1', 'user-1');
      await join(h, connection, 'user:user-1');

      expect(() =>
        h.subscriber.publish(`${KEY_PREFIX}realtime:user:user-1`, raw),
      ).not.toThrow();
      expect(sent).toEqual([]);
    });
  });

  describe('what this replica is subscribed to', () => {
    // A channel name is client-chosen, so a subscription that outlives its
    // last connection is a client-controlled leak — the same reason the
    // registry deletes an emptied channel index.
    it('unsubscribes when the last connection holding a channel goes', async () => {
      const h = harness();
      const { connection } = fakeConnection('c1', 'user-1');
      await join(h, connection, 'user:user-1');

      h.registry.remove(connection.id);
      await h.fanout.reconcile('user:user-1');

      expect(h.subscriber.subscribed.size).toBe(0);
    });

    it('stays subscribed while another connection still holds the channel', async () => {
      const h = harness();
      const a = fakeConnection('c1', 'user-1');
      const b = fakeConnection('c2', 'user-1');
      await join(h, a.connection, 'user:user-1');
      await join(h, b.connection, 'user:user-1');

      h.registry.remove(a.connection.id);
      await h.fanout.reconcile('user:user-1');

      expect([...h.subscriber.subscribed]).toEqual([
        `${KEY_PREFIX}realtime:user:user-1`,
      ]);

      h.subscriber.publish(
        `${KEY_PREFIX}realtime:user:user-1`,
        JSON.stringify({ payload: 'still here' }),
      );
      expect(b.sent).toHaveLength(1);
    });

    // `reconcile` reads the registry rather than trusting the caller's word,
    // so a subscribe and an unsubscribe racing on one channel settle on what
    // the registry actually holds instead of on whichever round trip finished
    // last.
    it('settles on the registry, whatever order it is called in', async () => {
      const h = harness();
      const { connection } = fakeConnection('c1', 'user-1');
      h.registry.add(connection);
      h.registry.subscribe(connection, 'user:user-1');

      await Promise.all([
        h.fanout.reconcile('user:user-1'),
        h.fanout.reconcile('user:user-1'),
        h.fanout.reconcile('user:user-1'),
      ]);

      expect([...h.subscriber.subscribed]).toEqual([
        `${KEY_PREFIX}realtime:user:user-1`,
      ]);
    });
  });
});

describe('decodeRealtimeFanout', () => {
  it('round-trips a payload', () => {
    expect(decodeRealtimeFanout(JSON.stringify({ payload: { a: 1 } }))).toEqual({
      payload: { a: 1 },
    });
  });

  it('accepts a null payload, which is a payload', () => {
    expect(decodeRealtimeFanout('{"payload":null}')).toEqual({ payload: null });
  });
});
