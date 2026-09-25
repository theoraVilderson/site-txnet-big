/**
 * Telling a payer the bank is returning a reversed payment (F-067-m, ADR-0046
 * decision 5) — the outbox's second consumer, on the first one's rules
 * (ADR-0045).
 *
 * What would break silently here, and nowhere else:
 *  - **delivery is at-least-once**: a redelivered event must not tell the payer
 *    twice, and its marker must not be the credited notice's — one payment can
 *    carry both events in its life, and neither may swallow the other;
 *  - a side effect that fails gives the marker back before rethrowing, so the
 *    event dead-letters still owed;
 *  - every reversal is told: unlike a credit, nobody watched it happen;
 *  - the live event goes to the payer's own `user:` channel, and the bot call
 *    carries the payment's tenant.
 */
import { IdentityHeaders, RequestHeaders, UnscopedRedisKeys, type OutboxMessage } from '@txnet-backend/shared-core';

import { PaymentReversedConsumer } from './payment-reversed.consumer';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const PAYMENT = '77777777-7777-4777-8777-777777777777';
const EVENT = '99999999-9999-4999-8999-999999999999';

function event(payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    id: EVENT,
    aggregate: 'billing.payment',
    aggregateId: PAYMENT,
    type: 'billing.payment.reversed',
    occurredAt: '2026-09-14T10:00:00Z',
    payload: {
      tenantId: TENANT,
      userId: USER,
      paymentId: PAYMENT,
      chargedAmountMinor: '19800000',
      amountCredited: '19.80',
      ...payload,
    },
  };
}

function build({ marked = false, notifyStatus = 200 }: { marked?: boolean; notifyStatus?: number } = {}) {
  const calls = {
    set: [] as unknown[][],
    del: [] as string[],
    published: [] as Array<{ channel: string; payload: unknown }>,
    fetched: [] as Array<{ url: string; headers: Record<string, string>; body: unknown }>,
    joined: [] as Array<{ burst: string; eventId: unknown; params: unknown }>,
  };
  const redis = {
    setNx: vi.fn(async (...args: unknown[]) => {
      calls.set.push(args);
      return !marked;
    }),
    del: vi.fn(async (key: string) => {
      calls.del.push(key);
    }),
    // F-067-p: the inbox and bot notice joins its burst; the first one claims the flush.
    evalScript: vi.fn(async (_script: string, keys: string[], args: unknown[]) => {
      calls.joined.push({ burst: keys[0]!, eventId: args[0], params: JSON.parse(String(args[1])) });
      return 1;
    }),
  };
  const realtime = {
    publish: vi.fn(async (channel: string, payload: unknown) => {
      calls.published.push({ channel, payload });
    }),
  };
  const broker = {
    consumePaymentReversed: vi.fn(),
    publishNoticeFlush: vi.fn(async () => {
      if (notifyStatus >= 400) throw new Error(`broker answered ${notifyStatus}`);
    }),
  };
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({ AUTH_API_BASE_URL: 'http://auth:3000/', SERVICE_AUTH_TOKEN: 'svc', AUTH_API_TIMEOUT_MS: 1000 })[key] ?? fallback,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      calls.fetched.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return { ok: notifyStatus < 400, status: notifyStatus, json: async () => ({ sent: ['telegram'] }) };
    }),
  );
  const consumer = new PaymentReversedConsumer(broker as never, redis as never, realtime as never, config as never);
  return { consumer, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('PaymentReversedConsumer.handle', () => {
  it('tells the payer live at once, and adds the inbox and bot notice to their burst (F-067-o, F-067-p)', async () => {
    const { consumer, calls } = build();

    await consumer.handle(event());

    expect(calls.set.map((c) => c[0])).toEqual(
      ['live', 'person'].map((channel) => UnscopedRedisKeys.outboxProcessed(`payment-reversed-notify:${channel}`, EVENT)),
    );
    expect(calls.published).toEqual([
      {
        channel: `user:${USER}`,
        payload: { type: 'billing.payment.reversed', paymentId: PAYMENT, amountCredited: '19.80' },
      },
    ]);
    expect(calls.joined).toEqual([
      { burst: UnscopedRedisKeys.noticeBurst(TENANT, USER, 'paymentReversed'), eventId: EVENT, params: { amount: '19.80' } },
    ]);
    expect(calls.fetched).toEqual([]);
    expect(calls.del).toEqual([]);
  });

  it('does nothing for an event it already handled', async () => {
    const { consumer, calls } = build({ marked: true });

    await consumer.handle(event());

    expect(calls.published).toEqual([]);
    expect(calls.fetched).toEqual([]);
  });

  it('gives the marker back and rethrows when its flush cannot be scheduled, so the event stays owed', async () => {
    const { consumer, calls } = build({ notifyStatus: 502 });

    await expect(consumer.handle(event())).rejects.toThrow(/502/);

    expect(calls.del).toEqual([
      UnscopedRedisKeys.noticeBurstScheduled(TENANT, USER, 'paymentReversed'),
      UnscopedRedisKeys.outboxProcessed(`payment-reversed-notify:person`, EVENT),
    ]);
  });

  it('refuses a payload without its tenant or user, rather than guessing whose it is', async () => {
    const { consumer, calls } = build();

    await expect(consumer.handle(event({ tenantId: undefined }))).rejects.toThrow(/payload/);
    expect(calls.set).toEqual([]);
  });
});
