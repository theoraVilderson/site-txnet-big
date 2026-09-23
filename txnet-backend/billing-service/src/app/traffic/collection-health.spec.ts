/**
 * The collection-health flag (F-027-w): `GET /api/billing/traffic/collection-health`.
 *
 * It exists for one sentence on the panel — *metering is unavailable, your
 * service is not cut off* — and the failure it prevents is a user reading a
 * stalled collector as a broken service. Three things about it are silent when
 * wrong, and each is asserted here:
 *
 *  - **the threshold.** It is five missed bulk passes, the same figure the
 *    external watchdog warns at (`network.rules.yml`,
 *    `NetworkCollectionStalled`). A flag that said "unavailable" on the panel
 *    while the operators' alert stayed quiet — or the reverse — would be two
 *    answers to one question;
 *  - **never collected is not healthy.** A panel with no
 *    `lastSuccessfulCollectionAt` has had nothing measured at all, which is
 *    the most unavailable a panel can be, not the least;
 *  - **whose configs.** The user comes from the gate's header, never from the
 *    query, and only configs that can carry traffic are counted — a disabled
 *    config on a stalled panel is not a service anybody is using.
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigStatus } from '@prisma/client';
import { RATE_LIMIT_KEY, RateLimitBucket, type RateLimitOptions, runWithTenant } from '@txnet-backend/shared-core';

import { CollectionHealthController } from './collection-health.controller';
import { CollectionHealthService, METERING_STATES, STALE_AFTER_SECONDS, judgeCollection } from './collection-health';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-09-23T12:00:00Z');
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

const req = (userId: string) => ({ identity: { userId, tenantId: TENANT, roleId: 'r', sessionId: 's', permissions: [] } });

describe('judgeCollection', () => {
  it('says healthy while every panel was collected within five passes', () => {
    const health = judgeCollection([{ panelId: 'p1', lastSuccessfulCollectionAt: ago(90) }], NOW);

    expect(health).toEqual({ metering: 'healthy', lastCollectedAt: ago(90), staleForSeconds: 90, configsAffected: 0 });
  });

  it('says unavailable past five passes — the figure the watchdog warns at', () => {
    // `collect.DefaultInterval` is 60s; `NetworkCollectionStalled` fires at
    // 300s. One question, one threshold.
    expect(STALE_AFTER_SECONDS).toBe(300);

    const health = judgeCollection([{ panelId: 'p1', lastSuccessfulCollectionAt: ago(301) }], NOW);

    expect(health.metering).toBe('unavailable');
    expect(health.configsAffected).toBe(1);
  });

  it('is still healthy on the boundary itself', () => {
    expect(judgeCollection([{ panelId: 'p1', lastSuccessfulCollectionAt: ago(300) }], NOW).metering).toBe('healthy');
  });

  it('reads a panel never collected as unavailable, never as healthy', () => {
    const health = judgeCollection([{ panelId: 'p1', lastSuccessfulCollectionAt: null }], NOW);

    expect(health).toEqual({ metering: 'unavailable', lastCollectedAt: null, staleForSeconds: null, configsAffected: 1 });
  });

  it('answers for the stalest panel, and counts every config on a stale one', () => {
    // A user with configs on two panels is as metered as the worse of them:
    // the one that stopped is the one they will notice.
    const health = judgeCollection(
      [
        { panelId: 'fresh', lastSuccessfulCollectionAt: ago(30) },
        { panelId: 'stale', lastSuccessfulCollectionAt: ago(1200) },
        { panelId: 'stale', lastSuccessfulCollectionAt: ago(1200) },
      ],
      NOW,
    );

    expect(health).toEqual({ metering: 'unavailable', lastCollectedAt: ago(1200), staleForSeconds: 1200, configsAffected: 2 });
  });

  it('has nothing to say for a user with no config that carries traffic', () => {
    expect(judgeCollection([], NOW)).toEqual({ metering: 'not_metered', lastCollectedAt: null, staleForSeconds: null, configsAffected: 0 });
  });

  it('answers only in the states it declares', () => {
    // C-09: the wire values are one declared tuple, which the panel's copy
    // (F-027-ac) is keyed on.
    expect([...METERING_STATES]).toEqual(['healthy', 'unavailable', 'not_metered']);
  });
});

describe('CollectionHealthService', () => {
  it("reads only the caller's configs that can carry traffic", async () => {
    let asked: unknown;
    const tx = {
      $executeRaw: async () => 0,
      config: {
        findMany: async (args: unknown) => {
          asked = args;
          return [{ panelId: 'p1', panel: { lastSuccessfulCollectionAt: ago(10) } }];
        },
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    const service = new CollectionHealthService(prisma as never);

    const health = await runWithTenant({ id: TENANT }, () => service.forUser(USER, NOW));

    expect(asked).toMatchObject({ where: { userId: USER, status: ConfigStatus.active, desiredEnabled: true } });
    expect(health.metering).toBe('healthy');
  });
});

describe('CollectionHealthController', () => {
  it('passes the gate’s user, never one from the query', async () => {
    const service = { forUser: vi.fn(async () => judgeCollection([], NOW)) };
    const controller = new CollectionHealthController(service as never);

    await controller.health({ ...req(USER), query: { userId: 'someone-else' } } as never);

    expect(service.forUser).toHaveBeenCalledWith(USER);
  });

  it('is a GET under billing/traffic, with a bucket of its own', () => {
    const handler = CollectionHealthController.prototype.health;
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata(PATH_METADATA, CollectionHealthController)).toBe('billing/traffic');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('collection-health');

    const limit = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitOptions;
    expect(limit.configKey).toBe('TRAFFIC_COLLECTION_HEALTH_RATE_LIMIT');
    expect(limit.key(req(USER) as never)).toBe(`${RateLimitBucket.TRAFFIC_COLLECTION_HEALTH}:${USER}`);
  });
});
