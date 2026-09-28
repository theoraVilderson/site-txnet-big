/**
 * Retention notices (F-601-a): a domain's retention event, told to its user's
 * inbox and bot once per Grant period, through the one notice path (ADR-0084).
 *
 * What would break silently here, and nowhere else:
 *  - **once per period is notification's ledger, asked first.** A producer
 *    that emits a threshold twice in one period, or a renewal that did not
 *    open a new one, must not reach the user twice — so nothing is told
 *    before `notification-service` says this event holds the (Grant, notice,
 *    period) row, and a `claimed: false` is an ack that sends nothing;
 *  - **a redelivery is still owed.** The claim is by event id, so the same
 *    event claims again after a failed send and the sender's markers stop a
 *    channel that already landed from repeating;
 *  - **whose Grant is never guessed**: a payload without its tenant, user,
 *    Grant or period, or without a param its notice names, throws before the
 *    claim — a claimed row whose notice was never told is a notice lost for
 *    the whole period;
 *  - **the words are auth-service's**: the template and exactly the params
 *    the table names, nothing else from the payload.
 */
import { RETENTION_KIND_OF, UnscopedRedisKeys, RequestHeaders, type OutboxMessage } from '@txnet-backend/shared-core';

import { RetentionNoticeConsumer } from './retention-notice.consumer';
import { RETENTION_NOTICES } from './retention-notices';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '99999999-9999-4999-8999-999999999991';
const EVENT = '88888888-8888-4888-8888-888888888888';
const TYPE = 'entitlement.grant.test_threshold';

function event(payload: Record<string, unknown> = {}): OutboxMessage {
  return {
    id: EVENT,
    aggregate: 'entitlement.grant',
    aggregateId: GRANT,
    type: TYPE,
    occurredAt: '2026-09-27T10:00:00Z',
    payload: { tenantId: TENANT, userId: USER, grantId: GRANT, period: '2026-09-01T00:00:00.000Z', level: '80', internal: 'x', ...payload },
  };
}

function build({
  claimed = true,
  claimStatus = 200,
  notificationUrl = 'http://notification:3000/',
  claims = undefined as Record<string, boolean | Record<string, unknown>> | undefined,
} = {}) {
  const calls = {
    fetched: [] as Array<{ url: string; headers: Record<string, string>; body: unknown }>,
    joined: [] as Array<{ burst: string; eventId: unknown; params: unknown }>,
  };
  const redis = {
    setNx: vi.fn(async () => true),
    del: vi.fn(async () => undefined),
    present: vi.fn(async (keys: string[]) => keys.map(() => false)),
    evalScript: vi.fn(async (_script: string, keys: string[], args: unknown[]) => {
      calls.joined.push({ burst: keys[0]!, eventId: args[0], params: JSON.parse(String(args[1])).params });
      return 1;
    }),
  };
  const broker = { consumeRetentionNotices: vi.fn(), publishNoticeFlush: vi.fn(async () => undefined) };
  const settings: Record<string, unknown> = {
    NOTIFICATION_API_BASE_URL: notificationUrl,
    AUTH_API_BASE_URL: 'http://auth:3000',
    SERVICE_AUTH_TOKEN: 'svc',
  };
  const config = { get: (k: string, fallback?: unknown) => (k in settings ? settings[k] : fallback) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body) as { notice: string };
      calls.fetched.push({ url, headers: init.headers, body });
      if (url.endsWith('/retention/hold')) return { ok: true, status: 200, json: async () => ({ ok: true, msg: 'ok', data: { held: true } }) };
      const answer = claims?.[body.notice] ?? claimed;
      // `true` is F-601-a's plain claim, told now; an object is the ledger's whole answer (F-601-m).
      const data = typeof answer === 'boolean' ? (answer ? { claimed: true, deliver: 'now' } : { claimed: false }) : answer;
      return { ok: claimStatus < 400, status: claimStatus, json: async () => ({ ok: true, msg: 'ok', data }) };
    }),
  );
  const consumer = new RetentionNoticeConsumer(broker as never, redis as never, { publish: vi.fn() } as never, config as never);
  consumer.notices = { [TYPE]: { template: 'testThreshold', params: ['level'] } };
  return { consumer, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('RetentionNoticeConsumer.handle', () => {
  it("claims the (Grant, notice, period) row by the event's id, then joins the user's burst with the named params only", async () => {
    const { consumer, calls } = build();

    await consumer.handle(event());

    expect(calls.fetched).toEqual([
      {
        url: 'http://notification:3000/api/internal/notifications/retention/claim',
        headers: { 'content-type': 'application/json', [RequestHeaders.serviceToken]: 'svc' },
        body: { eventId: EVENT, userId: USER, grantId: GRANT, notice: TYPE, period: '2026-09-01T00:00:00.000Z' },
      },
    ]);
    expect(calls.joined).toEqual([
      { burst: UnscopedRedisKeys.noticeBurst(TENANT, USER, 'testThreshold'), eventId: EVENT, params: { level: '80' } },
    ]);
  });

  // F-601-c: the tenant's support link rides along only when the tenant set one.
  it('passes an optional param when the payload has it, and tells without it when not', async () => {
    const { consumer, calls } = build();
    consumer.notices = { [TYPE]: { template: 'testThreshold', params: ['level'], optional: ['supportUrl'] } };

    await consumer.handle(event({ supportUrl: 'https://t.me/support' }));
    await consumer.handle({ ...event(), id: '88888888-8888-4888-8888-888888888889' });

    expect(calls.joined.map((j) => j.params)).toEqual([{ level: '80', supportUrl: 'https://t.me/support' }, { level: '80' }]);
  });

  it('tells nobody when the period already had this notice', async () => {
    const { consumer, calls } = build({ claimed: false });

    await consumer.handle(event());

    expect(calls.fetched).toHaveLength(1);
    expect(calls.joined).toEqual([]);
  });

  it('throws on a refused claim, so the event dead-letters still owed', async () => {
    const { consumer, calls } = build({ claimStatus: 503 });

    await expect(consumer.handle(event())).rejects.toThrow(/503/);
    expect(calls.joined).toEqual([]);
  });

  it('throws when notification-service is not configured', async () => {
    const { consumer } = build({ notificationUrl: '' });

    await expect(consumer.handle(event())).rejects.toThrow(/NOTIFICATION_API_BASE_URL/);
  });

  it('refuses, before claiming, a payload without its user, Grant, period or a named param', async () => {
    for (const missing of ['tenantId', 'userId', 'grantId', 'period', 'level']) {
      const { consumer, calls } = build();
      await expect(consumer.handle(event({ [missing]: undefined })), missing).rejects.toThrow(/payload/);
      expect(calls.fetched, missing).toEqual([]);
    }
  });

  it('refuses a type it has no notice for', async () => {
    const { consumer, calls } = build();

    await expect(consumer.handle({ ...event(), type: 'entitlement.grant.unknown' })).rejects.toThrow(/no retention notice/);
    expect(calls.fetched).toEqual([]);
  });

  // F-601-f: a usage level and a time level due the same day are one message — both ledger rows held by this event.
  describe('a time level carried on a usage notice', () => {
    const END = 'entitlement.grant.ends_in_3d';
    const END_PERIOD = '2026-09-30T22:00:00.000Z';
    const carried = (over: Record<string, unknown> = {}) => event({ endNotice: END, endPeriod: END_PERIOD, days: '4', ...over });
    const withAhead = (consumer: RetentionNoticeConsumer) => {
      consumer.notices = {
        [TYPE]: {
          template: 'testThreshold',
          params: ['level'],
          ahead: {
            types: [END],
            told: (days) => (days === '1' ? { template: 'testThresholdAndLastDay', params: [] } : { template: 'testThresholdAndEnd', params: ['days'] }),
          },
        },
        [END]: { template: 'testEnd', params: ['days'] },
      };
    };

    it('claims both rows for this event and tells one combined notice', async () => {
      const { consumer, calls } = build();
      withAhead(consumer);

      await consumer.handle(carried());

      expect(calls.fetched.map((f) => f.body)).toEqual([
        { eventId: EVENT, userId: USER, grantId: GRANT, notice: TYPE, period: '2026-09-01T00:00:00.000Z' },
        { eventId: EVENT, userId: USER, grantId: GRANT, notice: END, period: END_PERIOD },
      ]);
      expect(calls.joined).toEqual([
        { burst: UnscopedRedisKeys.noticeBurst(TENANT, USER, 'testThresholdAndEnd'), eventId: EVENT, params: { level: '80', days: '4' } },
      ]);
    });

    it("picks the last day's text by the days left", async () => {
      const { consumer, calls } = build();
      withAhead(consumer);

      await consumer.handle(carried({ days: '1' }));

      expect(calls.joined).toEqual([
        { burst: UnscopedRedisKeys.noticeBurst(TENANT, USER, 'testThresholdAndLastDay'), eventId: EVENT, params: { level: '80' } },
      ]);
    });

    it('tells the usage notice alone when the time level was already told', async () => {
      const { consumer, calls } = build({ claims: { [END]: false } });
      withAhead(consumer);

      await consumer.handle(carried());

      expect(calls.fetched).toHaveLength(2);
      expect(calls.joined).toEqual([{ burst: UnscopedRedisKeys.noticeBurst(TENANT, USER, 'testThreshold'), eventId: EVENT, params: { level: '80' } }]);
    });

    it('never claims the time level when the usage level was already told', async () => {
      const { consumer, calls } = build({ claims: { [TYPE]: false } });
      withAhead(consumer);

      await consumer.handle(carried());

      expect(calls.fetched.map((f) => (f.body as { notice: string }).notice)).toEqual([TYPE]);
      expect(calls.joined).toEqual([]);
    });

    it('refuses, before claiming, a carried level it does not accept or one without its period or days', async () => {
      for (const bad of [{ endNotice: 'entitlement.grant.usage_95' }, { endPeriod: undefined }, { days: undefined }]) {
        const { consumer, calls } = build();
        withAhead(consumer);
        await expect(consumer.handle(carried(bad)), JSON.stringify(bad)).rejects.toThrow(/payload/);
        expect(calls.fetched).toEqual([]);
      }
    });

    it('tells the usage notice alone when nothing is carried', async () => {
      const { consumer, calls } = build();
      withAhead(consumer);

      await consumer.handle(event());

      expect(calls.fetched).toHaveLength(1);
      expect(calls.joined.map((j) => j.burst)).toEqual([UnscopedRedisKeys.noticeBurst(TENANT, USER, 'testThreshold')]);
    });
  });

  /**
   * F-601-m: the ledger says how. `muted` tells nobody; `held` writes the
   * inbox row now and keeps the bot message on the ledger row for `botAt` —
   * never joined to a burst, whose flush would tell the bot at once.
   */
  describe('muted and quiet hours', () => {
    const BOT_AT = '2026-09-28T04:30:00.000Z';
    const told = (calls: ReturnType<typeof build>['calls']) => calls.fetched.filter((f) => f.url.includes('/notify/user')).map((f) => f.body);

    it('tells nobody when its kind is muted', async () => {
      const { consumer, calls } = build({ claims: { [TYPE]: { claimed: true, deliver: 'muted' } } });

      await consumer.handle(event());

      expect(calls.fetched).toHaveLength(1);
      expect(calls.joined).toEqual([]);
    });

    it('in quiet hours, keeps the bot message on the row first, then tells the inbox alone', async () => {
      const { consumer, calls } = build({ claims: { [TYPE]: { claimed: true, deliver: 'held', botAt: BOT_AT } } });

      await consumer.handle(event());

      expect(calls.fetched[1]).toMatchObject({
        url: 'http://notification:3000/api/internal/notifications/retention/hold',
        body: { eventId: EVENT, grantId: GRANT, notice: TYPE, period: '2026-09-01T00:00:00.000Z', tenantId: TENANT, template: 'testThreshold', params: { level: '80' }, botAt: BOT_AT },
      });
      expect(told(calls)).toEqual([{ userId: USER, channel: 'inbox', template: 'testThreshold', params: { level: '80' } }]);
      expect(calls.joined).toEqual([]);
    });

    it('a held patient notice joins the inbox-only hour lane instead of telling at once (F-601-q)', async () => {
      const { consumer, calls } = build({ claims: { [TYPE]: { claimed: true, deliver: 'held', botAt: BOT_AT } } });
      consumer.notices = { [TYPE]: { template: 'testThreshold', params: ['level'], patient: true } };

      await consumer.handle(event());

      expect(told(calls)).toEqual([]);
      expect(calls.joined.map((j) => j.burst)).toEqual([UnscopedRedisKeys.noticeBurst(TENANT, USER, 'testThreshold', 'hour', 'inbox')]);
    });

    it('throws on an answer that claims without saying how, before telling anyone', async () => {
      const { consumer, calls } = build({ claims: { [TYPE]: { claimed: true } } });

      await expect(consumer.handle(event())).rejects.toThrow(/how to tell/);
      expect(calls.joined).toEqual([]);
    });

    it('a muted usage level still tells the time level it carries, alone and in its own words', async () => {
      const END = 'entitlement.grant.ends_in_3d';
      const { consumer, calls } = build({ claims: { [TYPE]: { claimed: true, deliver: 'muted' } } });
      consumer.notices = {
        [TYPE]: { template: 'testThreshold', params: ['level'], ahead: { types: [END], told: () => ({ template: 'testThresholdAndEnd', params: ['days'] }) } },
        [END]: { template: 'testEnd', params: ['days'] },
      };

      await consumer.handle(event({ endNotice: END, endPeriod: 'e1', days: '3' }));

      expect(calls.joined).toEqual([{ burst: UnscopedRedisKeys.noticeBurst(TENANT, USER, 'testEnd'), eventId: EVENT, params: { days: '3' } }]);
    });

    it('a patient notice tells the claim it may wait, and joins the hour lane with its Grant (F-601-p)', async () => {
      const { consumer, calls } = build();
      consumer.notices = { [TYPE]: { template: 'testThreshold', params: ['level'], patient: true } };

      await consumer.handle(event());

      expect(calls.fetched[0]!.body).toMatchObject({ notice: TYPE, waitSec: 3600 });
      expect(calls.joined.map((j) => j.burst)).toEqual([UnscopedRedisKeys.noticeBurst(TENANT, USER, 'testThreshold', 'hour')]);
    });

    it('a patient level carrying an urgent one is told on the 10 s lane: an urgent notice never waits (F-601-p)', async () => {
      const END = 'entitlement.grant.ends_in_1d';
      const { consumer, calls } = build();
      consumer.notices = {
        [TYPE]: { template: 'testThreshold', params: ['level'], patient: true, ahead: { types: [END], told: () => ({ template: 'testThresholdAndLastDay', params: [] }) } },
        [END]: { template: 'testLastDay', params: [] },
      };

      await consumer.handle(event({ endNotice: END, endPeriod: 'e1', days: '1' }));

      expect(calls.fetched.map((f) => 'waitSec' in (f.body as object))).toEqual([true, false]);
      expect(calls.joined.map((j) => j.burst)).toEqual([UnscopedRedisKeys.noticeBurst(TENANT, USER, 'testThresholdAndLastDay')]);
    });

    it('only the non-urgent notices are patient (user 2026-09-28)', () => {
      const patient = Object.entries(RETENTION_NOTICES).filter(([, n]) => n?.patient).map(([type]) => type).sort();
      expect(patient).toEqual(
        [
          'entitlement.grant.ends_in_3d',
          'entitlement.grant.ends_in_7d',
          'entitlement.grant.idle',
          'entitlement.grant.not_connected',
          'entitlement.grant.runs_out_soon',
          'entitlement.grant.still_not_connected',
          'entitlement.grant.usage_50',
          'entitlement.grant.usage_80',
        ].sort(),
      );
    });

    it('every notice it tells has a kind the ledger reads its mute by', () => {
      expect(Object.keys(RETENTION_NOTICES).filter((type) => !(type in RETENTION_KIND_OF))).toEqual([]);
    });
  });
});
