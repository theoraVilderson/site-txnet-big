/**
 * One notice path for every event (F-067-o, ADR-0084 decision 2).
 *
 * What would break silently here, and nowhere else:
 *  - **each channel has its own marker** — `outboxProcessed(<consumer>:<channel>, id)` —
 *    so a redelivery repeats only the channel that failed, never a bot message
 *    or an inbox row that already landed;
 *  - a channel that throws **gives its marker back**, and the others still run
 *    before the sender rethrows, so one broken seam does not starve the rest;
 *  - inbox and bot are separate seam calls, each naming its `channel`.
 */
import { IdentityHeaders, UnscopedRedisKeys } from '@txnet-backend/shared-core';

import { EventNoticeSender, type EventNotice } from './event-notice';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const EVENT = '99999999-9999-4999-8999-999999999999';

function build({ marked = [] as string[], failChannel = null as null | 'inbox' | 'bot' } = {}) {
  const calls = { set: [] as string[], del: [] as string[], published: [] as string[], fetched: [] as Array<{ headers: Record<string, string>; body: { channel: string } }> };
  const redis = {
    setNx: vi.fn(async (key: string) => {
      calls.set.push(key);
      return !marked.includes(key);
    }),
    del: vi.fn(async (key: string) => {
      calls.del.push(key);
    }),
  };
  const realtime = { publish: vi.fn(async (channel: string) => void calls.published.push(channel)) };
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({ AUTH_API_BASE_URL: 'http://auth:3000', SERVICE_AUTH_TOKEN: 'svc', AUTH_API_TIMEOUT_MS: 1000 })[key] ?? fallback,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body);
      calls.fetched.push({ headers: init.headers, body });
      const ok = body.channel !== failChannel;
      return { ok, status: ok ? 200 : 502, json: async () => ({}) };
    }),
  );
  const sender = new EventNoticeSender(redis as never, realtime as never, config as never);
  return { sender, calls };
}

const notice: EventNotice = {
  consumer: 'payment-credited',
  eventId: EVENT,
  live: { channel: `user:${USER}`, body: { type: 'billing.payment.confirmed' } },
  person: { tenantId: TENANT, userId: USER, template: 'paymentCredited', params: { amount: '1' } },
};
const key = (channel: string) => UnscopedRedisKeys.outboxProcessed(`payment-credited:${channel}`, EVENT);

afterEach(() => vi.unstubAllGlobals());

describe('EventNoticeSender', () => {
  it('tells the event live, in the inbox and on the bot, each under its own marker', async () => {
    const { sender, calls } = build();
    await sender.send(notice);

    expect(calls.set).toEqual([key('live'), key('inbox'), key('bot')]);
    expect(calls.published).toEqual([`user:${USER}`]);
    expect(calls.fetched.map((f) => f.body.channel)).toEqual(['inbox', 'bot']);
    expect(calls.fetched[0]!.headers[IdentityHeaders.tenantId]).toBe(TENANT);
    expect(calls.del).toEqual([]);
  });

  it('a redelivery repeats only the channel that has not landed', async () => {
    const { sender, calls } = build({ marked: [key('live'), key('inbox')] });
    await sender.send(notice);

    expect(calls.published).toEqual([]);
    expect(calls.fetched.map((f) => f.body.channel)).toEqual(['bot']);
  });

  it('a failed channel gives its marker back, the others still run, and the send throws', async () => {
    const { sender, calls } = build({ failChannel: 'inbox' });
    await expect(sender.send(notice)).rejects.toThrow(/502/);

    expect(calls.fetched.map((f) => f.body.channel)).toEqual(['inbox', 'bot']);
    expect(calls.del).toEqual([key('inbox')]);
  });

  it('sends only the channels a notice declares', async () => {
    const liveOnly = build();
    await liveOnly.sender.send({ ...notice, person: undefined });
    expect(liveOnly.calls.set).toEqual([key('live')]);
    expect(liveOnly.calls.fetched).toEqual([]);

    const personOnly = build();
    await personOnly.sender.send({ ...notice, live: undefined });
    expect(personOnly.calls.published).toEqual([]);
    expect(personOnly.calls.fetched.map((f) => f.body.channel)).toEqual(['inbox', 'bot']);
  });
});
