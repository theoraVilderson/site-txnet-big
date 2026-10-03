import { RedisTtl, UnscopedRedisKeys } from '@txnet-backend/shared-core';

import { SupportNotifier, type NoticeRedis, type NoticeSeam, type NoticeTarget } from './support-notifier';

/**
 * New-message notices (F-033-i): one notice in the reader's panel inbox per
 * conversation until they read it.
 *
 * What breaks silently here: a notice per message (a chatty thread buries the
 * inbox), a notice that never comes back after the reader caught up (the
 * second reply of the day is never told), a refused seam that fails the
 * message it was about, and a refused seam remembered as told.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '3d8c81e4-9f15-4456-ac90-aba4ae55b517';
const ALICE = '33333333-3333-4333-8333-3333333333a1';

function fakeRedis(): NoticeRedis & { store: Map<string, { value: string; ttl: number }> } {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    async get(key) {
      return store.get(key)?.value ?? null;
    },
    async set(key, value, ttlSec) {
      store.set(key, { value, ttl: ttlSec });
    },
  };
}

function fakeSeam(): NoticeSeam & { told: { tenantId: string; body: Parameters<NoticeSeam['notify']>[1] }[]; failing: boolean } {
  const seam = {
    told: [] as { tenantId: string; body: Parameters<NoticeSeam['notify']>[1] }[],
    failing: false,
    async notify(tenantId: string, body: Parameters<NoticeSeam['notify']>[1]) {
      if (seam.failing) throw new Error('auth-api answered 503');
      seam.told.push({ tenantId, body });
    },
  };
  return seam;
}

const target = (readUpTo: number): NoticeTarget => ({
  conversationId: CONVERSATION,
  userId: ALICE,
  readUpTo,
  subject: 'My VPN stopped connecting',
});

describe('SupportNotifier (F-033-i)', () => {
  it('tells the reader once, in the inbox, by template, naming the conversation', async () => {
    const redis = fakeRedis();
    const seam = fakeSeam();
    const notifier = new SupportNotifier(redis, seam);

    expect(await notifier.tell(TENANT, 'supportReplied', target(3))).toBe(true);

    expect(seam.told).toEqual([
      {
        tenantId: TENANT,
        body: { userId: ALICE, channel: 'inbox', template: 'supportReplied', params: { subject: 'My VPN stopped connecting' } },
      },
    ]);
    // Remembered against how far the reader had read, for as long as the key lives.
    expect(redis.store.get(UnscopedRedisKeys.supportNotified(CONVERSATION, ALICE))).toEqual({
      value: '3',
      ttl: RedisTtl.supportNotified,
    });
  });

  it('stays quiet while the reader has not read since the last notice', async () => {
    const seam = fakeSeam();
    const notifier = new SupportNotifier(fakeRedis(), seam);

    await notifier.tell(TENANT, 'supportReplied', target(3));
    // A second reply, and a resolve: the cursor has not moved.
    expect(await notifier.tell(TENANT, 'supportReplied', target(3))).toBe(false);
    expect(await notifier.tell(TENANT, 'supportResolved', target(3))).toBe(false);

    expect(seam.told).toHaveLength(1);
  });

  it('tells again once the reader has read past the last notice', async () => {
    const seam = fakeSeam();
    const notifier = new SupportNotifier(fakeRedis(), seam);

    await notifier.tell(TENANT, 'supportReplied', target(3));
    expect(await notifier.tell(TENANT, 'supportReplied', target(5))).toBe(true);

    expect(seam.told).toHaveLength(2);
  });

  it('never fails the message, and a refused notice is not remembered as told', async () => {
    const redis = fakeRedis();
    const seam = fakeSeam();
    const notifier = new SupportNotifier(redis, seam);

    seam.failing = true;
    await expect(notifier.tell(TENANT, 'supportUserWrote', target(2))).resolves.toBe(false);
    expect(redis.store.size).toBe(0);

    seam.failing = false;
    expect(await notifier.tell(TENANT, 'supportUserWrote', target(2))).toBe(true);
  });

  it('cuts a long subject to what the seam takes', async () => {
    const seam = fakeSeam();
    await new SupportNotifier(fakeRedis(), seam).tell(TENANT, 'supportReplied', { ...target(1), subject: 'x'.repeat(500) });

    expect(seam.told[0].body.params.subject).toHaveLength(200);
  });
});
