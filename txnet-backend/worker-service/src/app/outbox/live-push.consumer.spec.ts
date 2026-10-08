/**
 * An outbox event that only an open page needs (F-111-l) — pushed live on the
 * owner's `user:` channel and told to nobody's inbox or bot.
 *
 * What would break silently here, and nowhere else:
 *  - **whose channel.** The event goes to the user the producer named in the
 *    payload; a wrong id is someone else's page re-reading, with no error;
 *  - **only a live push.** A config's lines being captured is not news worth a
 *    message: a Grant with three configs would be three bot messages;
 *  - a payload that does not say whose Grant it is is refused, never guessed;
 *  - the body carries the Grant and nothing the producer did not mean to share.
 */
import { OutboxEventType, type OutboxMessage } from '@txnet-backend/shared-core';

import { LIVE_PUSH_FIELDS, LivePushConsumer, liveChannel } from './live-push.consumer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '99999999-9999-4999-8999-999999999991';
const CONFIG = '77777777-7777-4777-8777-777777777777';
const EVENT = '88888888-8888-4888-8888-888888888888';

function event(payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    id: EVENT,
    aggregate: 'network.config',
    aggregateId: CONFIG,
    type: OutboxEventType.GRANT_LINKS_CAPTURED,
    occurredAt: '2026-09-26T10:00:00Z',
    payload: { tenantId: TENANT, userId: USER, grantId: GRANT, configId: CONFIG, ...payload },
  };
}

function build() {
  const published: Array<{ channel: string; payload: unknown }> = [];
  const realtime = {
    publish: vi.fn(async (channel: string, payload: unknown) => {
      published.push({ channel, payload });
    }),
  };
  const broker = { consumeLivePushes: vi.fn(), publishNoticeFlush: vi.fn() };
  const redis = { setNx: vi.fn(async () => true), del: vi.fn(), present: vi.fn(), evalScript: vi.fn() };
  const config = { get: (_key: string, fallback?: unknown) => fallback };
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const consumer = new LivePushConsumer(broker as never, redis as never, realtime as never, config as never);
  return { consumer, published, fetch, redis };
}

afterEach(() => vi.unstubAllGlobals());

describe('LivePushConsumer.handle', () => {
  it("pushes a capture on the owner's user channel, naming the Grant only", async () => {
    const { consumer, published } = build();

    await consumer.handle(event());

    expect(published).toEqual([
      { channel: `user:${USER}`, payload: { type: OutboxEventType.GRANT_LINKS_CAPTURED, grantId: GRANT } },
    ]);
  });

  it('tells no inbox and no bot', async () => {
    const { consumer, fetch, redis } = build();

    await consumer.handle(event());

    expect(fetch).not.toHaveBeenCalled();
    expect(redis.evalScript).not.toHaveBeenCalled();
  });

  it('refuses a payload without its user or Grant', async () => {
    const { consumer, published } = build();

    await expect(consumer.handle(event({ userId: '' }))).rejects.toThrow(/user/);
    await expect(consumer.handle(event({ grantId: undefined }))).rejects.toThrow(/grantId/);
    expect(published).toEqual([]);
  });

  it('refuses a type it has no row for', async () => {
    const { consumer } = build();

    await expect(consumer.handle({ ...event(), type: OutboxEventType.GRANT_CREATED })).rejects.toThrow(/live push/);
  });

  // F-111-m: the top bar re-reads the balance on any event of the owner's; the
  // body names no amount, so an out-of-order pair can never show an old one.
  it("pushes a Grant's committed total on the owner's channel, the tenant left behind (F-307-t)", async () => {
    const { consumer, published } = build();

    await consumer.handle({
      ...event(),
      aggregate: 'entitlement.grant',
      type: OutboxEventType.GRANT_USAGE,
      payload: { tenantId: TENANT, userId: USER, grantId: GRANT, consumedBytes: '1302694783' },
    });

    expect(published).toEqual([
      { channel: `user:${USER}`, payload: { type: OutboxEventType.GRANT_USAGE, grantId: GRANT, consumedBytes: '1302694783' } },
    ]);
  });

  it("pushes a wallet movement on the owner's channel with nothing but its type", async () => {
    const { consumer, published, fetch } = build();

    await consumer.handle({
      ...event(),
      aggregate: 'billing.wallet',
      type: OutboxEventType.WALLET_CHANGED,
      payload: { tenantId: TENANT, userId: USER, walletTransactionId: 'wt-1' },
    });

    expect(published).toEqual([{ channel: `user:${USER}`, payload: { type: OutboxEventType.WALLET_CHANGED } }]);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('tenant.domain.changed (RT-1-e)', () => {
  it("reaches the reseller owner's channel and the platform staff's, naming only the domain", async () => {
    const { consumer, published } = build();

    await consumer.handle({
      ...event(),
      aggregate: 'tenant.domain',
      type: OutboxEventType.TENANT_DOMAIN_CHANGED,
      payload: { tenantId: TENANT, userId: USER, resellerId: 'r-1', domainId: 'd-1' },
    });

    const body = { type: OutboxEventType.TENANT_DOMAIN_CHANGED, domainId: 'd-1' };
    expect(published).toEqual([
      { channel: `user:${USER}`, payload: body },
      { channel: `tenant:${TENANT}`, payload: body },
    ]);
  });
});

describe('tenant.subscription.renewed (F-019-c1)', () => {
  it("reaches the reseller owner's channel only, naming nothing", async () => {
    const { consumer, published } = build();

    await consumer.handle({
      ...event(),
      aggregate: 'tenant.subscription',
      type: OutboxEventType.TENANT_SUBSCRIPTION_RENEWED,
      payload: { tenantId: TENANT, userId: USER },
    });

    expect(published).toEqual([{ channel: `user:${USER}`, payload: { type: OutboxEventType.TENANT_SUBSCRIPTION_RENEWED } }]);
  });
});

// RT-1-b: a row names whose page re-reads — one user's, or a tenant's operators'.
describe('liveChannel', () => {
  it("names the user's channel for a user row and the tenant's for a tenant row", () => {
    const payload = { tenantId: TENANT, userId: USER };
    expect(liveChannel('user', payload, EVENT)).toBe(`user:${USER}`);
    expect(liveChannel('tenant', payload, EVENT)).toBe(`tenant:${TENANT}`);
  });

  it('refuses a payload without the id its audience needs, never falling back to the other', () => {
    expect(() => liveChannel('tenant', { userId: USER }, EVENT)).toThrow(/tenant/);
    expect(() => liveChannel('user', { tenantId: TENANT, userId: '' }, EVENT)).toThrow(/user/);
  });

  it('keeps every existing row on its owner: a balance or a Grant is nobody else’s', () => {
    for (const type of [OutboxEventType.GRANT_LINKS_CAPTURED, OutboxEventType.WALLET_CHANGED, OutboxEventType.GRANT_USAGE]) {
      expect(LIVE_PUSH_FIELDS[type]?.audience).toEqual(['user']);
    }
  });
});
