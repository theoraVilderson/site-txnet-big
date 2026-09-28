/**
 * Several of one user's services, one message (F-601-p, user 2026-09-28).
 *
 * What would break silently here, and nowhere else:
 *  - a **non-urgent** retention notice waits in an hour lane of its own — its
 *    own burst key and its own delay queue — so it never shares a burst, or a
 *    queue head, with a 10 s one; an urgent notice keeps the 10 s lane;
 *  - a combined flush **names the services**: it asks billing for the Grants'
 *    names once and hands them to auth-service beside `count`; a lookup that
 *    fails still tells the summary;
 *  - bot messages held for quiet hours and due together are **one message per
 *    template**, marked per ledger row, so a run repeated after a crash tells
 *    nothing twice.
 */
import { UnscopedRedisKeys } from '@txnet-backend/shared-core';

import { RetentionHeldNoticeJob } from '../jobs/retention-held-notice.job';
import { EventNoticeSender, NOTICE_BURST_ADD, NOTICE_BURST_TAKE, type EventNotice, type NoticeFlush } from './event-notice';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const grant = (n: number) => `22222222-2222-4222-8222-22222222222${n}`;
const event = (n: number) => `99999999-9999-4999-8999-99999999999${n}`;
const row = (n: number) => `77777777-7777-4777-8777-77777777777${n}`;

type Told = { channel: string; template: string; params: Record<string, string>; count?: number; services?: unknown[] };

function build({ namesFail = false, held = [] as Array<Record<string, unknown>> } = {}) {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const calls = { flushes: [] as Array<{ flush: NoticeFlush; delayMs: number }>, told: [] as Told[], names: [] as unknown[], cleared: [] as string[][] };
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
  const broker = { publishNoticeFlush: vi.fn(async (flush: NoticeFlush, delayMs: number) => void calls.flushes.push({ flush, delayMs })) };
  const config = {
    get: (key: string, fallback?: unknown) =>
      ({
        AUTH_API_BASE_URL: 'http://auth:3000',
        BILLING_API_BASE_URL: 'http://billing:3000',
        NOTIFICATION_API_BASE_URL: 'http://notification:3000',
        SERVICE_AUTH_TOKEN: 'svc',
        AUTOMATION_NOTICE_WINDOW_MS: 10_000,
        AUTOMATION_RETENTION_WINDOW_MS: 3_600_000,
      })[key] ?? fallback,
  };
  const ok = (data: unknown) => ({ ok: true, status: 200, json: async () => ({ ok: true, msg: 'ok', data }) });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      if (url.startsWith('http://billing')) {
        calls.names.push(body);
        if (namesFail) return { ok: false, status: 503, json: async () => ({}) };
        return ok({
          items: body.grantIds.map((id: string, i: number) => ({ grantId: id, label: i === 0 ? 'Home' : null, nameKey: 'catalog.product.month50.name', sku: 'M50', labels: [`friend-${i + 1}`] })),
        });
      }
      if (url.endsWith('/held/take')) return ok({ items: held });
      if (url.endsWith('/held/told')) {
        calls.cleared.push(body.ids);
        return ok({ cleared: body.ids.length });
      }
      calls.told.push(body);
      return ok({ sent: [] });
    }),
  );
  const sender = new EventNoticeSender(redis as never, {} as never, config as never, broker as never);
  const job = new RetentionHeldNoticeJob(redis as never, {} as never, config as never, broker as never);
  return { sender, job, calls, strings };
}

const endsSoon = (n: number, window?: 'hour'): EventNotice => ({
  consumer: 'retention-notice',
  eventId: event(n),
  person: { tenantId: TENANT, userId: USER, template: 'serviceEndsSoon', params: { days: '7' }, grantId: grant(n) },
  window,
});

afterEach(() => vi.unstubAllGlobals());

describe('F-601-p — a non-urgent notice waits in the hour lane', () => {
  it('the first of a burst schedules one flush an hour later, marked as the hour lane', async () => {
    const { sender, calls } = build();
    for (const n of [1, 2, 3]) await sender.send(endsSoon(n, 'hour'));

    expect(calls.flushes).toHaveLength(1);
    expect(calls.flushes[0]!.delayMs).toBe(3_600_000);
    expect(calls.flushes[0]!.flush).toMatchObject({ template: 'serviceEndsSoon', window: 'hour' });
  });

  it('an urgent notice of the same template is a burst of its own, on the 10 s lane', async () => {
    const { sender, calls } = build();
    await sender.send(endsSoon(1, 'hour'));
    await sender.send(endsSoon(2));

    expect(calls.flushes.map((f) => f.delayMs)).toEqual([3_600_000, 10_000]);
    expect(calls.flushes[1]!.flush.window).toBeUndefined();
  });

  it('the two lanes are two keys', () => {
    expect(UnscopedRedisKeys.noticeBurst(TENANT, USER, 'serviceEndsSoon', 'hour')).not.toBe(UnscopedRedisKeys.noticeBurst(TENANT, USER, 'serviceEndsSoon'));
    expect(UnscopedRedisKeys.noticeBurstScheduled(TENANT, USER, 'serviceEndsSoon', 'hour')).not.toBe(
      UnscopedRedisKeys.noticeBurstScheduled(TENANT, USER, 'serviceEndsSoon'),
    );
  });
});

describe('F-601-p — a combined flush names the services', () => {
  it('asks billing once for the burst’s Grants, and tells both channels the count and the names', async () => {
    const { sender, calls } = build();
    for (const n of [1, 2, 3]) await sender.send(endsSoon(n, 'hour'));
    await sender.flush(calls.flushes[0]!.flush);

    expect(calls.names).toEqual([{ tenantId: TENANT, userId: USER, grantIds: [grant(1), grant(2), grant(3)] }]);
    expect(calls.told.map((t) => t.channel)).toEqual(['inbox', 'bot']);
    for (const told of calls.told) {
      expect(told).toMatchObject({ template: 'serviceEndsSoon', count: 3, params: {} });
      // F-307-x: the buyer's name for a service rides beside its config labels.
      expect(told.services).toEqual([1, 2, 3].map((i) => ({ label: i === 1 ? 'Home' : null, nameKey: 'catalog.product.month50.name', sku: 'M50', labels: [`friend-${i}`] })));
    }
  });

  it('one notice alone is told as itself, with no lookup', async () => {
    const { sender, calls } = build();
    await sender.send(endsSoon(1, 'hour'));
    await sender.flush(calls.flushes[0]!.flush);

    expect(calls.names).toEqual([]);
    expect(calls.told[0]).toMatchObject({ params: { days: '7' } });
    expect(calls.told[0]!.count).toBeUndefined();
  });

  it('a lookup that fails still tells the summary, without names', async () => {
    const { sender, calls } = build({ namesFail: true });
    for (const n of [1, 2]) await sender.send(endsSoon(n, 'hour'));
    await sender.flush(calls.flushes[0]!.flush);

    expect(calls.told).toHaveLength(2);
    expect(calls.told[0]).toMatchObject({ count: 2 });
    expect(calls.told[0]!.services).toBeUndefined();
  });
});

describe('F-601-p — quiet hours release one message per template', () => {
  const heldRow = (n: number, template = 'serviceEndsSoon') => ({
    id: row(n),
    tenantId: TENANT,
    userId: USER,
    grantId: grant(n),
    template,
    params: { days: '7' },
  });

  it('three held for one template are one bot message with their names; another template is its own', async () => {
    const { job, calls } = build({ held: [heldRow(1), heldRow(2), heldRow(3), heldRow(4, 'serviceIdle')] });
    const result = await job.run();

    expect(calls.told).toHaveLength(2);
    expect(calls.told[0]).toMatchObject({ channel: 'bot', template: 'serviceEndsSoon', count: 3 });
    expect(calls.told[0]!.services).toHaveLength(3);
    expect(calls.told[1]).toMatchObject({ channel: 'bot', template: 'serviceIdle', params: { days: '7' } });
    expect(calls.cleared).toEqual([[row(1), row(2), row(3), row(4)]]);
    expect(result.itemsProcessed).toBe(4);
  });

  it('a run repeated after a crash before `told` tells nothing again, and clears the rows', async () => {
    const { job, calls } = build({ held: [heldRow(1), heldRow(2)] });
    await job.run();
    await job.run();

    expect(calls.told).toHaveLength(1);
    expect(calls.cleared).toEqual([[row(1), row(2)], [row(1), row(2)]]);
  });
});
