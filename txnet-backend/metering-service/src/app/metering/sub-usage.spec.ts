import { ConfigProtocol, PanelOwnershipType, Prisma } from '@prisma/client';
import { USAGE_DELTA_MESSAGE_VERSION, UnscopedRedisKeys, type UsageDeltaMessage } from '@txnet-backend/shared-core';

import { MeteringService } from './metering.service';
import { SubUsagePublisher, type SubUsageClient } from './sub-usage.publisher';

/**
 * Live usage for `/sub` (F-609-a).
 *
 * The rule on trial: **the Grant's committed total reaches Redis, and Redis can
 * never cost a delta.** The figure is a courtesy to a client app's usage bar;
 * the delta is money. So the write happens after the transaction commits, with
 * the total the database returned rather than one computed here, and every way
 * the write can fail — a rejected command, a thrown client — ends in a log line
 * and an acked pass.
 */

const TENANT = '22222222-2222-4222-8222-222222222222';
const CONFIG = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';

function store(startingAt = 5_000n) {
  const seen = new Set<string>();
  let consumed = startingAt;
  const client = {
    config: {
      findMany: async () => [{ id: CONFIG, tenantId: TENANT, grantId: GRANT, remoteId: 'client-a' }],
    },
    usageDeltaSeen: {
      findMany: async () => [],
      create: async ({ data }: { data: { deltaId: string } }) => {
        if (seen.has(data.deltaId)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
        }
        seen.add(data.deltaId);
        return data;
      },
    },
    trafficRawLog: { create: async ({ data }: { data: unknown }) => data },
    grant: {
      update: async ({ data }: { data: { consumedBytes: { increment: bigint } } }) => {
        consumed += data.consumedBytes.increment;
        return { consumedBytes: consumed, userId: 'u' };
      },
      // The page's usage push (F-307-t) is metering.service.spec.ts's; here it is never due.
      updateMany: async () => ({ count: 0 }),
    },
    usageDeltaQuarantine: { findMany: async () => [], createMany: async () => ({ count: 0 }) },
    $executeRaw: async () => 1,
    $transaction: async <R>(fn: (tx: unknown) => Promise<R>): Promise<R> => fn(client),
  };
  return client;
}

function pass(deltaIds: string[]): UsageDeltaMessage {
  return {
    version: USAGE_DELTA_MESSAGE_VERSION,
    panelId: '11111111-1111-4111-8111-111111111111',
    ownershipType: PanelOwnershipType.tenant,
    tenantId: TENANT,
    observedAt: '2026-09-24T10:00:00.000Z',
    chunk: 1,
    chunks: 1,
    deltas: deltaIds.map((deltaId) => ({
      deltaId,
      configId: CONFIG,
      remoteId: 'client-a',
      protocol: ConfigProtocol.vless,
      upBytes: '1000',
      downBytes: '2000',
      observedAt: '2026-09-24T10:00:00.000Z',
      sessionId: '',
      afterReset: false,
    })),
    quarantines: [],
    unattributed: [],
  };
}

/** A Redis that records what it was asked to run, or fails the way it is told to. */
function redis(fail?: 'reject' | 'throw') {
  const calls: Array<{ key: string; total: string; ttl: number }> = [];
  const client: SubUsageClient = {
    eval: (_script: string, _keys: number, key: string, total: string, ttl: number) => {
      if (fail === 'throw') throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false');
      if (fail === 'reject') return Promise.reject(new Error('connect ECONNREFUSED'));
      calls.push({ key, total, ttl });
      return Promise.resolve(1);
    },
  };
  return { client, calls };
}

function metering(db: ReturnType<typeof store>, publisher: SubUsagePublisher) {
  return new MeteringService(db as never, db as never, publisher);
}

describe('F-609-a: the delta consumer publishes the Grant total for /sub', () => {
  it('writes the committed consumedBytes under sub:usage:<grantId>, with the TTL', async () => {
    const r = redis();
    await metering(store(), new SubUsagePublisher(r.client, 86_400)).apply(pass(['d-1']));

    expect(r.calls).toEqual([{ key: UnscopedRedisKeys.subUsage(GRANT), total: '8000', ttl: 86_400 }]);
  });

  it('publishes the total after each delta, so the last write is the latest figure', async () => {
    const r = redis();
    await metering(store(), new SubUsagePublisher(r.client, 60)).apply(pass(['d-1', 'd-2']));

    expect(r.calls.map((c) => c.total)).toEqual(['8000', '11000']);
  });

  it('publishes nothing for a delta already applied — no transaction committed', async () => {
    const r = redis();
    const service = metering(store(), new SubUsagePublisher(r.client, 60));
    await service.apply(pass(['d-1']));
    await service.apply(pass(['d-1']));

    expect(r.calls).toHaveLength(1);
  });

  it.each(['reject', 'throw'] as const)('a Redis that fails (%s) never fails the delta', async (fail) => {
    const outcome = await metering(store(), new SubUsagePublisher(redis(fail).client, 60)).apply(pass(['d-1']));

    expect(outcome.applied).toBe(1);
  });

  it('the key is the one the redis-keyspace catalogue declares', () => {
    expect(UnscopedRedisKeys.subUsage(GRANT)).toBe(`sub:usage:${GRANT}`);
  });
});
