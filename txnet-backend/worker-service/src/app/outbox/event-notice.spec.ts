/**
 * One notice path for every event (F-067-o), and a burst told once (F-067-p,
 * ADR-0084 decisions 2 and 3).
 *
 * What would break silently here, and nowhere else:
 *  - the **live push is never combined** — it goes out at once, under its own marker;
 *  - inbox and bot notices for one recipient and one template are **combined**:
 *    the first event schedules one delayed flush, and the flush tells one
 *    summary with `count`, or the event itself when it was alone;
 *  - a redelivered event is **counted once**, and a flush redelivered after a
 *    failed channel repeats **only that channel, over the same batch**.
 *
 * The Redis fake below mirrors the two scripts in `event-notice.ts` over a Map;
 * the scripts themselves were run against the dev Redis when they were written.
 */
import { IdentityHeaders, UnscopedRedisKeys } from '@txnet-backend/shared-core';

import { EventNoticeSender, NOTICE_BURST_ADD, NOTICE_BURST_TAKE, type EventNotice, type NoticeFlush } from './event-notice';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';

type Fetched = {
  headers: Record<string, string>;
  body: { channel: string; template: string; params: Record<string, string>; count?: number; every?: boolean };
};

/** `sent`: what auth-api answers per channel (F-601-t); a channel absent answers `{}`, as before it said who was reached. */
function build({ failChannel = null as null | 'inbox' | 'bot' | 'sms', sent = {} as Record<string, string[]> } = {}) {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const calls = { published: [] as string[], flushes: [] as Array<{ flush: NoticeFlush; delayMs: number }>, fetched: [] as Fetched[] };
  const redis = {
    setNx: vi.fn(async (key: string) => {
      if (strings.has(key)) return false;
      strings.set(key, '1');
      return true;
    }),
    del: vi.fn(async (key: string) => void strings.delete(key)),
    present: vi.fn(async (keys: string[]) => keys.map((k) => strings.has(k))),
    evalScript: vi.fn(async (script: string, keys: string[], args: (string | number)[]) => {
      if (script === NOTICE_BURST_ADD) {
        const [burst, scheduled] = keys as [string, string];
        const hash = hashes.get(burst) ?? new Map<string, string>();
        hash.set(String(args[0]), String(args[1]));
        hashes.set(burst, hash);
        if (strings.has(scheduled)) return 0;
        strings.set(scheduled, String(args[4]));
        return 1;
      }
      if (script === NOTICE_BURST_TAKE) {
        const [scheduled, burst, batch] = keys as [string, string, string];
        if (!hashes.has(batch)) {
          if (strings.get(scheduled) === String(args[1])) strings.delete(scheduled);
          const taken = hashes.get(burst);
          if (taken) {
            hashes.set(batch, taken);
            hashes.delete(burst);
          }
        }
        return [...(hashes.get(batch) ?? new Map()).entries()].flat();
      }
      throw new Error('unknown script');
    }),
  };
  const realtime = { publish: vi.fn(async (channel: string) => void calls.published.push(channel)) };
  const broker = { publishNoticeFlush: vi.fn(async (flush: NoticeFlush, delayMs: number) => void calls.flushes.push({ flush, delayMs })) };
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({ AUTH_API_BASE_URL: 'http://auth:3000', SERVICE_AUTH_TOKEN: 'svc', AUTH_API_TIMEOUT_MS: 1000, AUTOMATION_NOTICE_WINDOW_MS: 10_000 })[key] ??
      fallback,
  };
  const failing = { channel: failChannel };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body);
      calls.fetched.push({ headers: init.headers, body });
      const ok = body.channel !== failing.channel;
      const data = sent[body.channel] ? { ok: true, data: { sent: sent[body.channel] } } : {};
      return { ok, status: ok ? 200 : 502, json: async () => data };
    }),
  );
  const sender = new EventNoticeSender(redis as never, realtime as never, config as never, broker as never);
  return { sender, calls, failing, strings };
}

const event = (n: number) => `99999999-9999-4999-8999-99999999999${n}`;
const notice = (n: number, overrides: Partial<EventNotice['person']> = {}): EventNotice => ({
  consumer: 'panel-tested',
  eventId: event(n),
  live: { channel: `tenant:${TENANT}`, body: { type: 'network.panel.tested' } },
  person: { tenantId: TENANT, userId: USER, template: 'panelRefused', params: { panel: `edge-${n}` }, ...overrides },
});

afterEach(() => vi.unstubAllGlobals());

describe('EventNoticeSender — the live push', () => {
  it('goes out at once under its own marker, and a redelivery does not repeat it', async () => {
    const { sender, calls } = build();
    await sender.send(notice(1));
    await sender.send(notice(1));

    expect(calls.published).toEqual([`tenant:${TENANT}`]);
    expect(calls.fetched).toEqual([]);
  });
});

describe('EventNoticeSender — a burst is told once', () => {
  it('the first event schedules one flush after the window; the rest of the burst joins it', async () => {
    const { sender, calls } = build();
    for (const n of [1, 2, 3]) await sender.send(notice(n));

    expect(calls.published).toHaveLength(3);
    expect(calls.flushes).toHaveLength(1);
    expect(calls.flushes[0]!.delayMs).toBe(10_000);
    expect(calls.flushes[0]!.flush).toMatchObject({ tenantId: TENANT, userId: USER, template: 'panelRefused' });
  });

  it('the flush tells one summary with its count, once in the inbox and once on the bot', async () => {
    const { sender, calls } = build();
    for (const n of [1, 2, 3]) await sender.send(notice(n));
    await sender.flush(calls.flushes[0]!.flush);

    expect(calls.fetched.map((f) => f.body.channel)).toEqual(['inbox', 'bot']);
    expect(calls.fetched[0]!.body).toMatchObject({ userId: USER, template: 'panelRefused', count: 3, params: {} });
    expect(calls.fetched[0]!.headers[IdentityHeaders.tenantId]).toBe(TENANT);
  });

  it('an event alone is told as itself, with its own params and no count', async () => {
    const { sender, calls } = build();
    await sender.send(notice(1));
    await sender.flush(calls.flushes[0]!.flush);

    expect(calls.fetched[0]!.body.params).toEqual({ panel: 'edge-1' });
    expect(calls.fetched[0]!.body.count).toBeUndefined();
  });

  it('a redelivered event is counted once', async () => {
    const { sender, calls } = build();
    await sender.send(notice(1));
    await sender.send(notice(1));
    await sender.send(notice(2));
    await sender.flush(calls.flushes[0]!.flush);

    expect(calls.fetched[0]!.body.count).toBe(2);
  });

  it('another recipient or another template is a burst of its own', async () => {
    const { sender, calls } = build();
    await sender.send(notice(1));
    await sender.send(notice(2, { userId: OTHER_USER }));
    await sender.send(notice(3, { template: 'paymentCredited' }));

    expect(calls.flushes).toHaveLength(3);
  });

  it('after a flush, the next event opens a new burst', async () => {
    const { sender, calls } = build();
    await sender.send(notice(1));
    await sender.flush(calls.flushes[0]!.flush);
    await sender.send(notice(2));

    expect(calls.flushes).toHaveLength(2);
  });

  it('a flush redelivered after a failed channel repeats only that channel, over the same batch', async () => {
    const { sender, calls, failing } = build({ failChannel: 'bot' });
    await sender.send(notice(1));
    await sender.send(notice(2));
    const first = calls.flushes[0]!.flush;
    await expect(sender.flush(first)).rejects.toThrow(/502/);

    // An event after the failed flush belongs to the next burst, not to this batch.
    await sender.send(notice(3));
    failing.channel = null;
    await sender.flush(first);

    const bot = calls.fetched.filter((f) => f.body.channel === 'bot');
    expect(calls.fetched.filter((f) => f.body.channel === 'inbox')).toHaveLength(1);
    expect(bot).toHaveLength(2);
    expect(bot[1]!.body.count).toBe(2);
    expect(calls.flushes).toHaveLength(2);
  });

  it('a flush with nothing to tell sends nothing', async () => {
    const { sender, calls } = build();
    await sender.flush({ flushId: 'f', tenantId: TENANT, userId: USER, template: 'panelRefused' });
    expect(calls.fetched).toEqual([]);
  });

  it('a flush that could not be scheduled gives the event back, so a redelivery schedules it', async () => {
    const { sender, calls } = build();
    const broker = (sender as unknown as { broker: { publishNoticeFlush: ReturnType<typeof vi.fn> } }).broker;
    broker.publishNoticeFlush.mockRejectedValueOnce(new Error('unroutable'));
    await expect(sender.send(notice(1))).rejects.toThrow(/unroutable/);

    await sender.send(notice(1));
    expect(calls.flushes).toHaveLength(1);
  });

  it('the markers are per channel and keyed by the flush', () => {
    expect(UnscopedRedisKeys.noticeBurst(TENANT, USER, 'panelRefused')).toContain(USER);
    expect(UnscopedRedisKeys.noticeBurstBatch('f1')).toContain('f1');
  });

  // ADR-0084 consequences: a marker rename is accepted once (F-067-o), never again.
  it('an event already told on one channel before F-067-p is finished on the other alone, never joined', async () => {
    const { sender, calls, strings } = build();
    strings.set(UnscopedRedisKeys.outboxProcessed(`panel-tested:inbox`, event(1)), '1');
    await sender.send(notice(1));

    expect(calls.flushes).toEqual([]);
    expect(calls.fetched.map((f) => f.body.channel)).toEqual(['bot']);
    expect(calls.fetched[0]!.body.params).toEqual({ panel: 'edge-1' });

    await sender.send(notice(1));
    expect(calls.fetched).toHaveLength(1);
  });
});

describe('EventNoticeSender — a notice’s class decides its channels (F-601-s, ADR-0097)', () => {
  it('an info notice joins an inbox-only burst: several are one inbox row, and no bot', async () => {
    const { sender, calls } = build();
    for (const n of [1, 2]) await sender.send(notice(n, { template: 'panelAccepted' }));

    expect(calls.flushes).toHaveLength(1);
    expect(calls.flushes[0]!.delayMs).toBe(10_000);
    expect(calls.flushes[0]!.flush).toMatchObject({ template: 'panelAccepted', only: 'inbox' });
    expect(calls.flushes[0]!.flush.window).toBeUndefined();

    await sender.flush(calls.flushes[0]!.flush);
    expect(calls.fetched.map((f) => f.body.channel)).toEqual(['inbox']);
    expect(calls.fetched[0]!.body.count).toBe(2);
  });

  it('the class a consumer states wins over its template’s, both ways', async () => {
    const { sender, calls } = build();
    await sender.send({ ...notice(1), class: 'info' });
    await sender.send({ ...notice(2, { template: 'panelAccepted' }), class: 'important' });

    expect(calls.flushes.map((f) => [f.flush.template, f.flush.only])).toEqual([
      ['panelRefused', 'inbox'],
      ['panelAccepted', undefined],
    ]);
  });
});

describe('EventNoticeSender — SMS for a critical or security notice (F-601-t, ADR-0097)', () => {
  const critical = (n: number) => notice(n, { template: 'paymentReversed', params: { amount: '10' } });
  const channels = (calls: { fetched: Fetched[] }) => calls.fetched.map((f) => f.body.channel);

  it('a critical notice no bot reached is told by SMS, after the bot', async () => {
    const { sender, calls } = build({ sent: { bot: [], sms: ['sms'] } });
    await sender.send(critical(1));
    await sender.flush(calls.flushes[0]!.flush);

    expect(channels(calls)).toEqual(['inbox', 'bot', 'sms']);
    expect(calls.fetched[2]!.body).toMatchObject({ template: 'paymentReversed', params: { amount: '10' } });
  });

  it('a critical notice a bot reached is not told by SMS', async () => {
    const { sender, calls } = build({ sent: { bot: ['telegram'] } });
    await sender.send(critical(1));
    await sender.flush(calls.flushes[0]!.flush);

    expect(channels(calls)).toEqual(['inbox', 'bot']);
  });

  it('an important notice no bot reached is never told by SMS', async () => {
    const { sender, calls } = build({ sent: { bot: [] } });
    await sender.send(notice(1));
    await sender.flush(calls.flushes[0]!.flush);

    expect(channels(calls)).toEqual(['inbox', 'bot']);
  });

  it('a bot that failed is no bot reached: the SMS that lands settles the notice', async () => {
    const { sender, calls } = build({ failChannel: 'bot', sent: { sms: ['sms'] } });
    await sender.send(critical(1));
    await expect(sender.flush(calls.flushes[0]!.flush)).resolves.toBeUndefined();

    expect(channels(calls)).toEqual(['inbox', 'bot', 'sms']);
  });

  it('a failed bot with no SMS to fall to stays owed, and a redelivery asks the bot again', async () => {
    const { sender, calls, failing } = build({ failChannel: 'bot', sent: { sms: [] } });
    await sender.send(critical(1));
    const flush = calls.flushes[0]!.flush;
    await expect(sender.flush(flush)).rejects.toThrow(/502/);

    failing.channel = null;
    await sender.flush(flush);
    expect(channels(calls)).toEqual(['inbox', 'bot', 'sms', 'bot']);
  });

  it('an SMS that failed after a bot reached no one is owed, and the redelivery repeats nothing that landed', async () => {
    const { sender, calls, failing } = build({ failChannel: 'sms', sent: { bot: [] } });
    await sender.send(critical(1));
    const flush = calls.flushes[0]!.flush;
    await expect(sender.flush(flush)).rejects.toThrow(/502/);

    failing.channel = null;
    await sender.flush(flush);
    expect(channels(calls)).toEqual(['inbox', 'bot', 'sms', 'bot', 'sms']);
  });

  it('a security notice goes to every linked chat and by SMS, each owed on its own', async () => {
    const { sender, calls } = build({ sent: { bot: ['telegram', 'bale'], sms: ['sms'] } });
    await sender.send({ ...notice(1), class: 'security' });
    await sender.flush(calls.flushes[0]!.flush);

    expect(channels(calls)).toEqual(['inbox', 'bot', 'sms']);
    expect(calls.fetched[1]!.body.every).toBe(true);
    expect(calls.fetched[0]!.body.every).toBeUndefined();
  });

  it('a burst takes its strongest notice’s class', async () => {
    const { sender, calls } = build({ sent: { bot: [], sms: ['sms'] } });
    await sender.send({ ...notice(1), class: 'important' });
    await sender.send({ ...notice(2), class: 'critical' });
    await sender.flush(calls.flushes[0]!.flush);

    expect(channels(calls)).toEqual(['inbox', 'bot', 'sms']);
  });
});
