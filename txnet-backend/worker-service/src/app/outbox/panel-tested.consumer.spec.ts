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
  const broker = { consumePanelTested: vi.fn(), publishNoticeFlush: vi.fn(async () => undefined) };
  const joined: Array<{ burst: string; params: unknown }> = [];
  const redis = {
    setNx: vi.fn(async () => true),
    del: vi.fn(),
    present: vi.fn(async (keys: string[]) => keys.map(() => false)),
    // F-067-p: the owner's notice joins their burst, told after the window.
    evalScript: vi.fn(async (_script: string, keys: string[], args: unknown[]) => {
      joined.push({ burst: keys[0]!, params: JSON.parse(String(args[1])).params });
      return 1;
    }),
  };
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
  return { consumer, published, told, joined, redis };
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

  it("tells the owner a verdict in their inbox and on their bot, naming the panel (F-067-o, combined F-067-p)", async () => {
    const { consumer, joined, redis } = build();

    await consumer.handle(event({ reviewState: 'refused', fault: null, ownerUserId: OWNER, panelName: 'Frankfurt' }));

    expect(joined).toEqual([{ burst: UnscopedRedisKeys.noticeBurst(TENANT, OWNER, 'panelRefused'), params: { panel: 'Frankfurt' } }]);
    expect(redis.setNx.mock.calls.map((c) => (c as unknown[])[0])).toEqual(
      ['live', 'person'].map((channel) => UnscopedRedisKeys.outboxProcessed(`panel-tested:${channel}`, EVENT)),
    );
  });

  it('tells nobody about a fault, nor an event that does not name its owner', async () => {
    const { consumer, told, joined, published } = build();

    await consumer.handle(event({ ownerUserId: OWNER }));
    await consumer.handle(event({ reviewState: 'accepted_low_trust', fault: null }));

    expect(told).toEqual([]);
    expect(joined).toEqual([]);
    expect(published).toHaveLength(2);
  });
});

/**
 * F-027-el (ADR-0122): a confirmed change of a panel's health rides the same
 * queue. What breaks silently: a cause told as the wrong fix (a changed port
 * sent as "re-enter the login"), a recovery nobody hears about, or a cause the
 * worker does not know — told as nothing instead of refused.
 */
function changed(payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    ...event(),
    type: 'network.panel.state_changed',
    payload: {
      panelId: PANEL,
      tenantId: TENANT,
      ownerUserId: OWNER,
      panelName: 'Frankfurt',
      panelState: 'down',
      previousState: 'healthy',
      cause: 'connection_refused',
      since: '2026-10-06T06:05:55.255Z',
      ...payload,
    },
  };
}

describe('PanelTestedConsumer.handle — a panel state change (F-027-el)', () => {
  it("pushes it on the owner's tenant channel with the cause", async () => {
    const { consumer, published } = build();

    await consumer.handle(changed());

    expect(published).toEqual([
      {
        channel: `tenant:${TENANT}`,
        payload: { type: OutboxEventType.PANEL_STATE_CHANGED, panelId: PANEL, panelState: 'down', cause: 'connection_refused' },
      },
    ]);
  });

  it.each([
    ['dns_failed', 'panelDownDns'],
    ['connection_refused', 'panelDownPort'],
    ['unreachable', 'panelDownUnreachable'],
    ['unresponsive', 'panelDownUnreachable'],
    ['tls_failed', 'panelDownTls'],
    ['not_found', 'panelDownPath'],
    ['server_error', 'panelDownServer'],
    ['bad_answer', 'panelDownServer'],
    ['login_refused', 'panelLoginRefused'],
    ['forbidden', 'panelRefusingUs'],
    ['rate_limited', 'panelRefusingUs'],
  ])('tells the owner %s as %s, naming the panel', async (cause, template) => {
    const { consumer, joined } = build();

    await consumer.handle(changed({ cause }));

    expect(joined).toEqual([{ burst: UnscopedRedisKeys.noticeBurst(TENANT, OWNER, template), params: { panel: 'Frankfurt' } }]);
  });

  it('tells the owner a recovery, in the inbox alone (an `info` notice)', async () => {
    const { consumer, joined } = build();

    await consumer.handle(changed({ panelState: 'healthy', previousState: 'down', cause: null }));

    expect(joined).toEqual([
      { burst: UnscopedRedisKeys.noticeBurst(TENANT, OWNER, 'panelRecovered', undefined, 'inbox'), params: { panel: 'Frankfurt' } },
    ]);
  });

  it('refuses a cause it does not know rather than telling the owner nothing', async () => {
    const { consumer, published } = build();

    await expect(consumer.handle(changed({ cause: 'cosmic_rays' }))).rejects.toThrow(/cause/);
    expect(published).toEqual([]);
  });
});

/**
 * F-027-fg (ADR-0130 decision 5): a halting drift event rides the same queue.
 * What breaks silently: users cut off while the event waits on a page nobody
 * opens — so it is pushed live and told to the owner, naming the panel, by
 * what happened; and an event type the worker does not know is refused, not
 * told as nothing.
 */
function drift(payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    ...event(),
    type: 'network.panel.drift_raised',
    payload: { panelId: PANEL, tenantId: TENANT, ownerUserId: OWNER, panelName: 'Frankfurt', driftEventId: EVENT, eventType: 'identity_lost', ...payload },
  };
}

describe('PanelTestedConsumer.handle — a halting drift event (F-027-fg)', () => {
  it("pushes it on the owner's tenant channel with its type", async () => {
    const { consumer, published } = build();

    await consumer.handle(drift());

    expect(published).toEqual([
      { channel: `tenant:${TENANT}`, payload: { type: OutboxEventType.PANEL_DRIFT_RAISED, panelId: PANEL, driftEventId: EVENT, eventType: 'identity_lost' } },
    ]);
  });

  it.each([
    ['mass_reset', 'panelHaltedRestore'],
    ['mass_missing', 'panelHaltedDrift'],
    ['mass_rename', 'panelHaltedDrift'],
    ['mass_limit_override', 'panelHaltedDrift'],
    ['foreign_claim', 'panelHaltedForeign'],
    ['identity_lost', 'panelHaltedIdentity'],
    ['address_moved', 'panelHaltedAddress'],
  ])('tells the owner %s as %s, naming the panel', async (eventType, template) => {
    const { consumer, joined } = build();

    await consumer.handle(drift({ eventType }));

    expect(joined).toEqual([{ burst: UnscopedRedisKeys.noticeBurst(TENANT, OWNER, template), params: { panel: 'Frankfurt' } }]);
  });

  it('refuses an event type it does not know rather than telling the owner nothing', async () => {
    const { consumer, published } = build();

    await expect(consumer.handle(drift({ eventType: 'cosmic_rays' }))).rejects.toThrow(/drift event type/);
    expect(published).toEqual([]);
  });
});
