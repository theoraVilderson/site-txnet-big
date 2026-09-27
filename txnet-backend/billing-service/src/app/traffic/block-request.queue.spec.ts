/**
 * The block-request queue (F-027-dk, ADR-0093) — what is left of the hot
 * loop's broker end once the lease planner is the only thing that sizes a
 * share or asks for a block.
 *
 * The invariant: **a collection pass reaches nothing in billing.** The durable
 * queue keeps its name, so the binding on `network.usage.#` it carried since
 * F-027-cl is still on the broker; unless boot removes it, every pass keeps
 * landing here and is acked unread forever. A block request is the one message
 * that still buys, and it must still reach `BlockRequestService`.
 */
import { BLOCK_REQUEST_MESSAGE_VERSION, BLOCK_REQUEST_ROUTING_KEY, NETWORK_USAGE_ROUTING_PREFIX, USAGE_DELTA_ROUTING_KEY, topicBindingAll } from '@txnet-backend/shared-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const broker = vi.hoisted(() => ({
  bound: [] as string[],
  unbound: [] as string[],
  acked: 0,
  nacked: 0,
  onMessage: undefined as undefined | ((m: unknown) => Promise<void>),
}));

vi.mock('amqplib', () => ({
  connect: async () => ({
    on: () => undefined,
    close: async () => undefined,
    createChannel: async () => ({
      assertExchange: async () => undefined,
      assertQueue: async () => undefined,
      bindQueue: async (_q: string, _x: string, key: string) => void broker.bound.push(key),
      unbindQueue: async (_q: string, _x: string, key: string) => void broker.unbound.push(key),
      prefetch: async () => undefined,
      consume: async (_q: string, fn: (m: unknown) => Promise<void>) => void (broker.onMessage = fn),
      ack: () => void broker.acked++,
      nack: () => void broker.nacked++,
      close: async () => undefined,
    }),
  }),
}));

import { BlockRequestQueue } from './block-request.queue';

const config = { getOrThrow: (key: string) => key };

function message(routingKey: string, body: unknown) {
  return { fields: { routingKey }, content: Buffer.from(JSON.stringify(body)) };
}

async function boot() {
  const handled: unknown[] = [];
  const blockRequests = { handle: async (req: { grantId: string }) => (handled.push(req), { outcome: 'handled', grantId: req.grantId }) };
  await new BlockRequestQueue(config as never, blockRequests as never).onApplicationBootstrap();
  return { handled };
}

beforeEach(() => {
  broker.bound = [];
  broker.unbound = [];
  broker.acked = 0;
  broker.nacked = 0;
  broker.onMessage = undefined;
});

describe('BlockRequestQueue', () => {
  it('binds the block request alone, and takes the retired usage binding off the durable queue', async () => {
    await boot();
    expect(broker.bound).toEqual([BLOCK_REQUEST_ROUTING_KEY]);
    expect(broker.unbound).toEqual([topicBindingAll(NETWORK_USAGE_ROUTING_PREFIX)]);
  });

  it('acks a collection pass still in the queue without handing it to anything', async () => {
    const { handled } = await boot();
    await broker.onMessage?.(message(USAGE_DELTA_ROUTING_KEY, { panelId: 'p1' }));
    expect(handled).toEqual([]);
    expect(broker.acked).toBe(1);
    expect(broker.nacked).toBe(0);
  });

  it('hands a block request to BlockRequestService, and dead-letters one that does not parse', async () => {
    const { handled } = await boot();
    const request = {
      version: BLOCK_REQUEST_MESSAGE_VERSION,
      grantId: '4b0c7d1e-2f3a-4b5c-8d6e-7f8091a2b3c4',
      purchasedBytes: '419430400',
      targetBytes: '2097152000',
      rateBps: '100000000',
      requestedAt: '2026-09-27T10:00:00Z',
    };
    await broker.onMessage?.(message(BLOCK_REQUEST_ROUTING_KEY, request));
    expect(handled).toHaveLength(1);
    expect(broker.acked).toBe(1);

    await broker.onMessage?.(message(BLOCK_REQUEST_ROUTING_KEY, { not: 'a request' }));
    expect(broker.nacked).toBe(1);
    expect(handled).toHaveLength(1);
  });
});
