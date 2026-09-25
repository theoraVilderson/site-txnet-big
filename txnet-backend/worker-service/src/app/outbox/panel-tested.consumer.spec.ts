/**
 * A connection test's verdict or fault reaching an open systems page
 * (F-027-bs) — the first outbox consumer that pushes on a `tenant:` channel.
 *
 * What would break silently here, and nowhere else:
 *  - **whose channel.** The event goes to the tenant `network-service` named in
 *    the payload (the panel's, or the platform owner's for a platform panel);
 *    a wrong id is another reseller's page re-reading, with no error anywhere;
 *  - a payload that does not say whose panel it is is refused, never guessed;
 *  - only a **verdict** is told to the owner's inbox and bot (F-067-o): a fault
 *    repeats every 5 minutes while it lasts, and each would be a message.
 */
import { OutboxEventType, UnscopedRedisKeys, type OutboxMessage } from '@txnet-backend/shared-core';

import { PanelTestedConsumer } from './panel-tested.consumer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const PANEL = '55555555-5555-4555-8555-555555555555';
const OWNER = '44444444-4444-4444-8444-444444444444';
const EVENT = '99999999-9999-4999-8999-999999999999';

function event(payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    id: EVENT,
    aggregate: 'network.panel',
    aggregateId: PANEL,
    type: 'network.panel.tested',
    occurredAt: '2026-09-25T08:00:00Z',
    payload: { panelId: PANEL, tenantId: TENANT, reviewState: 'pending', fault: 'unreachable', ...payload },
  };
}

function build() {
  const published: Array<{ channel: string; payload: unknown }> = [];
  const realtime = {
    publish: vi.fn(async (channel: string, payload: unknown) => {
      published.push({ channel, payload });
    }),
  };
  const broker = { consumePanelTested: vi.fn() };
  const redis = { setNx: vi.fn(async () => true), del: vi.fn() };
  const config = {
    get: (key: string, fallback?: unknown) => ({ AUTH_API_BASE_URL: 'http://auth:3000', SERVICE_AUTH_TOKEN: 'svc' })[key] ?? fallback,
  };
  const told: Array<{ channel: string; template: string; userId: string; params: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      told.push(JSON.parse(init.body));
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
  const consumer = new PanelTestedConsumer(broker as never, redis as never, realtime as never, config as never);
  return { consumer, published, told, redis };
}

afterEach(() => vi.unstubAllGlobals());

describe('PanelTestedConsumer.handle', () => {
  it("pushes the verdict or fault on the owner's tenant channel", async () => {
    const { consumer, published } = build();

    await consumer.handle(event());
    await consumer.handle(event({ reviewState: 'accepted', fault: null }));

    expect(published).toEqual([
      {
        channel: `tenant:${TENANT}`,
        payload: { type: OutboxEventType.PANEL_TESTED, panelId: PANEL, reviewState: 'pending', fault: 'unreachable' },
      },
      {
        channel: `tenant:${TENANT}`,
        payload: { type: OutboxEventType.PANEL_TESTED, panelId: PANEL, reviewState: 'accepted', fault: null },
      },
    ]);
  });

  it('refuses a payload without its tenant or panel, rather than guessing whose it is', async () => {
    const { consumer, published } = build();

    // A platform panel with no platform_owner tenant to name arrives as null.
    await expect(consumer.handle(event({ tenantId: null }))).rejects.toThrow(/payload/);
    await expect(consumer.handle(event({ panelId: '' }))).rejects.toThrow(/payload/);
    expect(published).toEqual([]);
  });

  it("tells the owner a verdict in their inbox and on their bot, naming the panel (F-067-o)", async () => {
    const { consumer, told, redis } = build();

    await consumer.handle(event({ reviewState: 'refused', fault: null, ownerUserId: OWNER, panelName: 'Frankfurt' }));

    expect(told).toEqual(
      ['inbox', 'bot'].map((channel) => ({ userId: OWNER, channel, template: 'panelRefused', params: { panel: 'Frankfurt' } })),
    );
    expect(redis.setNx.mock.calls.map((c) => (c as unknown[])[0])).toEqual(
      ['live', 'inbox', 'bot'].map((channel) => UnscopedRedisKeys.outboxProcessed(`panel-tested:${channel}`, EVENT)),
    );
  });

  it('tells nobody about a fault, nor an event that does not name its owner', async () => {
    const { consumer, told, published } = build();

    await consumer.handle(event({ ownerUserId: OWNER }));
    await consumer.handle(event({ reviewState: 'accepted_low_trust', fault: null }));

    expect(told).toEqual([]);
    expect(published).toHaveLength(2);
  });
});
