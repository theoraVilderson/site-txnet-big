/**
 * A purchase delivered the moment it is paid (F-114-i), and no outbox event
 * announced to nobody.
 *
 * What would break silently here, and nowhere else:
 *  - **`entitlement.grant.created` asks billing to deliver that Grant now**,
 *    over the internal seam; the minute `grant_delivery` sweep stays the
 *    backstop, so a refusal throws (dead-letters) rather than being swallowed;
 *  - **every outbox event type has a queue bound to it.** The relay publishes
 *    `mandatory` and never skips a row, so one unbound type is `unroutable`
 *    for ever and holds every later event behind it — which is what
 *    `entitlement.grant.created` did until this row. `OUTBOX_EVENT_BINDER`
 *    names who binds each type (a new type does not compile without one); this
 *    holds worker-service's broker to the types it claims.
 */
import { OUTBOX_EVENT_BINDER, OutboxEventType, outboxRoutingKey, RequestHeaders, type OutboxMessage } from '@txnet-backend/shared-core';

vi.mock('amqplib', () => ({ connect: vi.fn() }));
import * as amqp from 'amqplib';

import { BrokerService } from '../broker/broker.service';
import { GrantCreatedConsumer } from './grant-created.consumer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const GRANT = '99999999-9999-4999-8999-999999999991';
const EVENT = '88888888-8888-4888-8888-888888888888';

function event(payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    id: EVENT,
    aggregate: 'entitlement.grant',
    aggregateId: GRANT,
    type: OutboxEventType.GRANT_CREATED,
    occurredAt: '2026-09-25T10:00:00Z',
    payload: { tenantId: TENANT, grantId: GRANT, status: 'pending', ...payload },
  };
}

const settings: Record<string, unknown> = { BILLING_API_BASE_URL: 'http://billing:3000/', SERVICE_AUTH_TOKEN: 'svc', BILLING_API_TIMEOUT_MS: 1000 };
const config = { get: (k: string, fallback?: unknown) => (k in settings ? settings[k] : fallback) };

function consumer(answer: { status?: number; body?: unknown } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(answer.body ?? { ok: true, msg: 'ok', data: { outcome: 'delivered' } }), { status: answer.status ?? 200 });
    }),
  );
  return { consumer: new GrantCreatedConsumer({ consumeGrantCreated: vi.fn() } as never, config as never), calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('GrantCreatedConsumer (F-114-i)', () => {
  it('asks billing to deliver that Grant now, as a service', async () => {
    const { consumer: c, calls } = consumer();
    await c.handle(event());
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://billing:3000/api/internal/billing/entitlement/grants/${GRANT}/deliver`);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)[RequestHeaders.serviceToken]).toBe('svc');
  });

  it('asks billing to fulfil the Grant a confirmed config serves, not to deliver it again (F-111-n)', async () => {
    const { consumer: c, calls } = consumer({ body: { ok: true, msg: 'ok', data: { outcome: 'activated' } } });
    await c.handle({ ...event({ configId: 'cfg-1' }), aggregate: 'network.config', type: OutboxEventType.CONFIG_CONFIRMED });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`http://billing:3000/api/internal/billing/network/grants/${GRANT}/fulfil`);
    expect((calls[0].init.headers as Record<string, string>)[RequestHeaders.serviceToken]).toBe('svc');
  });

  it('throws on a refusal or an answer without its outcome — the sweep stands behind it', async () => {
    await expect(consumer({ status: 500 }).consumer.handle(event())).rejects.toThrow(/500/);
    await expect(consumer({ body: { ok: true, msg: 'ok', data: {} } }).consumer.handle(event())).rejects.toThrow(/outcome/);
  });

  it('never guesses which Grant: a payload without one throws before any call', async () => {
    const { consumer: c, calls } = consumer();
    await expect(c.handle(event({ grantId: undefined }))).rejects.toThrow(/Grant/);
    expect(calls).toHaveLength(0);
  });
});

describe('every outbox event type has a bound queue (F-114-i)', () => {
  async function workerBindings(): Promise<Set<string>> {
    const bound = new Set<string>();
    const channel = new Proxy(
      { bindQueue: async (_q: string, _x: string, key: string) => void bound.add(key) },
      // Anything else the setup calls answers `{}`; `then` stays unset, or awaiting the channel never settles.
      { get: (target, prop) => (prop in target ? target[prop as keyof typeof target] : prop === 'then' ? undefined : async () => ({})) },
    );
    vi.mocked(amqp.connect).mockResolvedValue({ createConfirmChannel: async () => channel, on: () => undefined } as never);
    const env = new Proxy({} as Record<string, unknown>, { get: (_t, k) => (k === 'BOT_UPDATE_QUEUES' ? 1 : `x-${String(k)}`) });
    await new BrokerService({ getOrThrow: (k: string) => env[k] } as never).onModuleInit();
    return bound;
  }

  it('names who binds every type', () => {
    for (const type of Object.values(OutboxEventType)) expect(OUTBOX_EVENT_BINDER[type], type).toMatch(/-service$/);
  });

  it("binds exactly the types worker-service claims, the purchase's own included", async () => {
    const bound = await workerBindings();
    const claimed = Object.values(OutboxEventType).filter((t) => OUTBOX_EVENT_BINDER[t] === 'worker-service');
    expect(claimed).toContain(OutboxEventType.GRANT_CREATED);
    expect(claimed).toContain(OutboxEventType.CONFIG_CONFIRMED);
    for (const type of claimed) expect(bound.has(outboxRoutingKey(type)), type).toBe(true);
    const others = Object.values(OutboxEventType).filter((t) => OUTBOX_EVENT_BINDER[t] !== 'worker-service');
    for (const type of others) expect(bound.has(outboxRoutingKey(type)), type).toBe(false);
  });
});
