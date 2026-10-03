import { decodeRealtimeFanout } from '@txnet-backend/shared-core';

import { SupportRealtime, type SupportRealtimeRedis } from './support-realtime';

/**
 * Live conversations (F-034): the proof a reader subscribes with, and the
 * events published on `support:<conversationId>`.
 *
 * What breaks silently here: a proof re-minted on every read (the reader's
 * other tab can no longer subscribe), a proof keyed without the reader (anyone
 * holding it subscribes), an event published without the keyspace prefix
 * (delivered to nobody, reported as sent), and an event that carries what the
 * channel's other readers must not see.
 */

const PREFIX = 'txnet:auth:v2:';
const CONVERSATION = '3d8c81e4-9f15-4456-ac90-aba4ae55b517';
const ALICE = { tenantId: '11111111-1111-4111-8111-111111111111', userId: '33333333-3333-4333-8333-3333333333a1' };

function fakeRedis(): SupportRealtimeRedis & { store: Map<string, { value: string; ttl: number }>; published: [string, string][] } {
  const store = new Map<string, { value: string; ttl: number }>();
  const published: [string, string][] = [];
  return {
    keyPrefix: PREFIX,
    store,
    published,
    async setNx(key, value, ttlSec) {
      if (store.has(key)) return false;
      store.set(key, { value, ttl: ttlSec });
      return true;
    },
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async expire(key, ttlSec) {
      const row = store.get(key);
      if (row) row.ttl = ttlSec;
    },
    async publish(channel, message) {
      published.push([channel, message]);
      return 1;
    },
  };
}

const payloadOf = (raw: string) => decodeRealtimeFanout(raw)?.payload as Record<string, unknown>;

describe('the channel proof', () => {
  it('is minted once per reader and conversation, keyed by both, and reused while it lives', async () => {
    const redis = fakeRedis();
    const realtime = new SupportRealtime(redis);
    const first = await realtime.channelProof(ALICE, CONVERSATION);
    const second = await realtime.channelProof(ALICE, CONVERSATION);

    expect(first.channel).toBe(`support:${CONVERSATION}`);
    expect(first.proof).toMatch(/^[0-9a-f]{64}$/);
    expect(second.proof).toBe(first.proof);
    expect([...redis.store.keys()]).toEqual([`support:channel:${CONVERSATION}:${ALICE.userId}`]);
  });

  it('refreshes its lifetime on every read, so an open thread keeps a valid proof', async () => {
    const redis = fakeRedis();
    const realtime = new SupportRealtime(redis);
    await realtime.channelProof(ALICE, CONVERSATION);
    redis.store.get(`support:channel:${CONVERSATION}:${ALICE.userId}`)!.ttl = 5;
    const again = await realtime.channelProof(ALICE, CONVERSATION);
    expect(redis.store.get(`support:channel:${CONVERSATION}:${ALICE.userId}`)!.ttl).toBe(again.expiresInSec);
  });

  it('is null when Redis is down — the thread still reads, it just is not live', async () => {
    const redis = fakeRedis();
    redis.setNx = async () => {
      throw new Error('connection lost');
    };
    expect(await new SupportRealtime(redis).channelProof(ALICE, CONVERSATION)).toBeNull();
  });
});

describe('events on support:<conversationId>', () => {
  const message = {
    id: 'm1',
    seq: 4,
    senderKind: 'user' as const,
    mine: true,
    body: 'hello',
    createdAt: new Date('2026-10-03T10:00:00Z'),
    attachments: [],
  };

  it('publishes a new message on the prefixed fan-out name, without the per-reader `mine`', async () => {
    const redis = fakeRedis();
    await new SupportRealtime(redis).message(CONVERSATION, message, 'open');
    const [[wire, raw]] = redis.published;
    expect(wire).toBe(`${PREFIX}realtime:support:${CONVERSATION}`);
    const payload = payloadOf(raw);
    expect(payload).toMatchObject({ kind: 'support.message', conversationId: CONVERSATION, status: 'open' });
    expect(payload['message']).toMatchObject({ id: 'm1', seq: 4, senderKind: 'user', body: 'hello' });
    expect(payload['message']).not.toHaveProperty('mine');
  });

  it('publishes read and typing with who did it by kind, never by account', async () => {
    const redis = fakeRedis();
    const realtime = new SupportRealtime(redis);
    await realtime.read(CONVERSATION, 'user', 7);
    await realtime.typing(CONVERSATION, 'user');
    const [read, typing] = redis.published.map(([, raw]) => payloadOf(raw));
    expect(read).toEqual({ kind: 'support.read', conversationId: CONVERSATION, readerKind: 'user', lastReadSeq: 7 });
    expect(typing).toEqual({ kind: 'support.typing', conversationId: CONVERSATION, senderKind: 'user', expiresInMs: 6000 });
  });

  it('swallows a failed publish: the message was stored, the event is only the notice', async () => {
    const redis = fakeRedis();
    redis.publish = async () => {
      throw new Error('connection lost');
    };
    await expect(new SupportRealtime(redis).message(CONVERSATION, message, 'open')).resolves.toBeUndefined();
  });
});
