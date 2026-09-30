/**
 * A Grant's daily usage (F-307-b): `GET /api/billing/traffic/grants/:grantId/usage`,
 * the service page's 30-day chart.
 *
 * `traffic_daily_aggregate` has no `tenantId` and no policy of its own
 * (network data-model.md): nothing in the database stops a read of another
 * user's rows. So the three things asserted here are the whole fence:
 *
 *  - **whose rows.** The aggregate is read only through the configs of a Grant
 *    the gate's user owns; another user's Grant is the same 404 as a missing
 *    one, and no aggregate is read for it;
 *  - **a retired config still counts.** Its bytes were spent against the Grant,
 *    so the chart would otherwise shrink when the user deletes a config;
 *  - **the window is 30 days, today included, one entry per day** — a day with
 *    no row is a zero, so the chart never has to fill gaps; bytes are strings.
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NotFoundException } from '@nestjs/common';
import { RATE_LIMIT_KEY, RateLimitBucket, type RateLimitOptions, runWithTenant } from '@txnet-backend/shared-core';

import { GRANT_USAGE_DAYS, GrantUsageService } from './grant-usage';
import { UserConfigsController } from './user-configs.controller';
import type { UserConfigsService } from './user-configs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '22222222-2222-4222-8222-222222222222';
const C1 = '55555555-5555-4555-8555-555555555501';
const C2 = '55555555-5555-4555-8555-555555555502';
const NOW = new Date('2026-09-26T21:30:00Z');

const req = (userId: string) => ({ identity: { userId, tenantId: TENANT, roleId: 'r', sessionId: 's', permissions: [] } });

type Sum = { date: Date; _sum: { totalUploadBytes: bigint | null; totalDownloadBytes: bigint | null } };

function build(opts: { grant?: { id: string } | null; configIds?: string[]; sums?: Sum[] } = {}) {
  const asked: { grantWhere?: unknown; configWhere?: unknown; aggregate?: Record<string, unknown> } = {};
  const tx = {
    $executeRaw: async () => 0,
    grant: {
      findFirst: async (args: { where: unknown }) => {
        asked.grantWhere = args.where;
        return opts.grant === undefined ? { id: GRANT } : opts.grant;
      },
    },
    config: {
      findMany: async (args: { where: unknown }) => {
        asked.configWhere = args.where;
        return (opts.configIds ?? [C1, C2]).map((id) => ({ id }));
      },
    },
    trafficDailyAggregate: {
      groupBy: async (args: Record<string, unknown>) => {
        asked.aggregate = args;
        return opts.sums ?? [];
      },
    },
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  const service = new GrantUsageService(prisma as never);
  return { service, asked };
}

const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);

describe('GrantUsageService.dailyForGrant', () => {
  it('answers 30 days ending today (UTC), oldest first, a missing day as zero', async () => {
    const { service } = build({
      sums: [
        { date: new Date('2026-09-26T00:00:00Z'), _sum: { totalUploadBytes: BigInt(5), totalDownloadBytes: BigInt(7) } },
        { date: new Date('2026-08-28T00:00:00Z'), _sum: { totalUploadBytes: BigInt(1), totalDownloadBytes: null } },
      ],
    });
    const view = await inTenant(() => service.dailyForGrant(USER, GRANT, NOW));

    expect(GRANT_USAGE_DAYS).toBe(30);
    expect(view.from).toBe('2026-08-28');
    expect(view.to).toBe('2026-09-26');
    expect(view.days).toHaveLength(30);
    expect(view.days[0]).toEqual({ date: '2026-08-28', uploadBytes: '1', downloadBytes: '0' });
    expect(view.days[1]).toEqual({ date: '2026-08-29', uploadBytes: '0', downloadBytes: '0' });
    expect(view.days[29]).toEqual({ date: '2026-09-26', uploadBytes: '5', downloadBytes: '7' });
  });

  it('keeps bytes past 2^53 exact, as decimal strings', async () => {
    const big = BigInt('9007199254740993');
    const { service } = build({ sums: [{ date: new Date('2026-09-20T00:00:00Z'), _sum: { totalUploadBytes: big, totalDownloadBytes: big } }] });
    const view = await inTenant(() => service.dailyForGrant(USER, GRANT, NOW));
    expect(view.days.find((d) => d.date === '2026-09-20')).toEqual({ date: '2026-09-20', uploadBytes: '9007199254740993', downloadBytes: '9007199254740993' });
  });

  it('reads the aggregate only through the owned Grant configs, retired ones included, inside the window', async () => {
    const { service, asked } = build();
    await inTenant(() => service.dailyForGrant(USER, GRANT, NOW));

    expect(asked.grantWhere).toEqual({ id: GRANT, userId: USER });
    // No status filter: a retired config's bytes were spent against this Grant.
    expect(asked.configWhere).toEqual({ grantId: GRANT, userId: USER });
    expect(asked.aggregate?.by).toEqual(['date']);
    expect(asked.aggregate?.where).toEqual({
      configId: { in: [C1, C2] },
      date: { gte: new Date('2026-08-28T00:00:00Z'), lte: new Date('2026-09-26T00:00:00Z') },
    });
  });

  it('reads no aggregate for a Grant the user does not own, and says grant_not_found', async () => {
    const { service, asked } = build({ grant: null });
    await expect(inTenant(() => service.dailyForGrant(USER, GRANT, NOW))).rejects.toMatchObject({ reason: 'grant_not_found' });
    expect(asked.configWhere).toBeUndefined();
    expect(asked.aggregate).toBeUndefined();
  });

  it('answers 30 zero days for a Grant with no configs, without querying the aggregate', async () => {
    const { service, asked } = build({ configIds: [] });
    const view = await inTenant(() => service.dailyForGrant(USER, GRANT, NOW));
    expect(view.days).toHaveLength(30);
    expect(view.days.every((d) => d.uploadBytes === '0' && d.downloadBytes === '0')).toBe(true);
    expect(asked.aggregate).toBeUndefined();
  });
});

describe('UserConfigsController.usage', () => {
  const proto = UserConfigsController.prototype;

  it('is GET grants/:grantId/usage behind its own per-user bucket', () => {
    expect(Reflect.getMetadata(PATH_METADATA, proto.usage)).toBe('grants/:grantId/usage');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.usage)).toBe(0);
    const rl = Reflect.getMetadata(RATE_LIMIT_KEY, proto.usage) as RateLimitOptions;
    expect(rl.configKey).toBe('GRANT_USAGE_RATE_LIMIT');
    expect(rl.key(req(USER) as never)).toContain(RateLimitBucket.GRANT_USAGE);
    expect(rl.key(req(USER) as never)).toContain(USER);
  });

  it('answers a Grant the user does not own as 404', async () => {
    const { service } = build({ grant: null });
    const controller = new UserConfigsController({} as UserConfigsService, service, {} as never);
    await expect(inTenant(() => controller.usage(GRANT, req(USER) as never))).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers the grant id with the days', async () => {
    const { service } = build();
    const controller = new UserConfigsController({} as UserConfigsService, service, {} as never);
    const out = await inTenant(() => controller.usage(GRANT, req(USER) as never));
    expect(out.grantId).toBe(GRANT);
    expect(out.days).toHaveLength(30);
  });
});
