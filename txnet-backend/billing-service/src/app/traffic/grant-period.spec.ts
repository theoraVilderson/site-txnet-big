/**
 * A metered Grant's billing period (F-118-ai):
 * `GET /api/billing/traffic/grants/:grantId/period`, what the service card
 * shows in place of a bag that read as a limit (user, 2026-09-30).
 *
 *  - **the period is the Grant's own month**: anniversaries of `startsAt`, the
 *    day clamped to a short month, and the one before it; none before the first;
 *  - **this period's bytes are live**: the lifetime counter less the rolled days
 *    before the period's UTC day — the nightly rollup never holds today; the
 *    last period is the rolled days between its two turns;
 *  - **money is the ledger's**: this Grant's usage charges less their refunds,
 *    in the wallet's currency, inside the period;
 *  - **what the balance covers** is the bag left plus the bytes the money the
 *    Grant may still spend buys at its rate — its cap and its own reserve counted;
 *  - another user's Grant is the same 404 as a missing one, a package plan 409.
 */
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RATE_LIMIT_KEY, RateLimitBucket, type RateLimitOptions, runWithTenant } from '@txnet-backend/shared-core';

import { periodBounds } from '../usage/cap-funding';
import { GrantPeriodService } from './grant-period';
import { UserConfigsController } from './user-configs.controller';
import type { GrantUsageService } from './grant-usage';
import type { UserConfigsService } from './user-configs';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GRANT = '22222222-2222-4222-8222-222222222222';
const WALLET = '66666666-6666-4666-8666-666666666666';
const GIB = BigInt(1073741824);
const NOW = new Date('2026-09-30T10:00:00Z');
const STARTS = new Date('2026-07-08T14:00:00Z');

const req = (userId: string) => ({ identity: { userId, tenantId: TENANT, roleId: 'r', sessionId: 's', permissions: [] } });
const D = (v: string | number) => new Prisma.Decimal(v);

type Sum = { date: Date; _sum: { totalUploadBytes: bigint | null; totalDownloadBytes: bigint | null } };
type Ledger = { reasonType: string; direction: 'debit' | 'credit'; amount: string; createdAt: Date; currencyCode?: string };

function build(
  opts: {
    grant?: Record<string, unknown> | null;
    meter?: Record<string, unknown> | null;
    wallet?: Record<string, unknown> | null;
    sums?: Sum[];
    ledger?: Ledger[];
    held?: string;
    room?: (available: Prisma.Decimal, own: Prisma.Decimal) => Prisma.Decimal;
  } = {},
) {
  const asked: { grantWhere?: unknown; aggregate?: Record<string, unknown>[]; ledger?: Record<string, unknown>[] } = { aggregate: [], ledger: [] };
  const grant =
    opts.grant === undefined
      ? { id: GRANT, userId: USER, startsAt: STARTS, billingMode: 'metered', trafficUnlimited: false, purchasedBytes: BigInt(5) * GIB, consumedBytes: BigInt(3) * GIB }
      : opts.grant;
  const tx = {
    $executeRaw: async () => 0,
    grant: {
      findFirst: async (args: { where: unknown }) => {
        asked.grantWhere = args.where;
        return grant;
      },
    },
    grantMeter: {
      findUnique: async () =>
        opts.meter === undefined ? { unitSize: GIB, unitPrice: D('2.5'), currencyCode: 'USD', mode: 'prepaid' } : opts.meter,
    },
    wallet: {
      findUnique: async () =>
        opts.wallet === undefined ? { id: WALLET, cachedBalance: D('12'), heldAmount: D('2'), currencyCode: 'USD' } : opts.wallet,
    },
    config: { findMany: async () => [{ id: 'c1' }] },
    trafficDailyAggregate: {
      aggregate: async (args: { where: { date: { lt: Date } } }) => {
        asked.aggregate!.push(args);
        const days = (opts.sums ?? []).filter((s) => s.date < args.where.date.lt);
        const add = (k: 'totalUploadBytes' | 'totalDownloadBytes') => days.reduce((n, d) => n + (d._sum[k] ?? BigInt(0)), BigInt(0));
        return { _sum: { totalUploadBytes: add('totalUploadBytes'), totalDownloadBytes: add('totalDownloadBytes') } };
      },
    },
    walletTransaction: {
      findMany: async (args: { where: { createdAt: { gte: Date; lt: Date }; currencyCode: string } }) => {
        asked.ledger!.push(args);
        const { gte, lt } = args.where.createdAt;
        return (opts.ledger ?? [])
          .filter((l) => l.createdAt >= gte && l.createdAt < lt && (l.currencyCode ?? 'USD') === args.where.currencyCode)
          .map((l) => ({ ...l, amount: D(l.amount) }));
      },
    },
  };
  const caps = {
    heldFor: async () => D(opts.held ?? '0'),
    within: async (_tx: unknown, _g: unknown, available: Prisma.Decimal, own: Prisma.Decimal) =>
      opts.room ? opts.room(available, own) : available,
  };
  const prisma = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) };
  const service = new GrantPeriodService(prisma as never, caps as never);
  return { service, asked };
}

const inTenant = <T>(fn: () => Promise<T>) => runWithTenant({ id: TENANT }, fn);
const day = (iso: string, up: number, down: number): Sum => ({
  date: new Date(`${iso}T00:00:00Z`),
  _sum: { totalUploadBytes: BigInt(up), totalDownloadBytes: BigInt(down) },
});

describe('periodBounds', () => {
  it('runs from the latest anniversary of the anchor to the next, time kept', () => {
    expect(periodBounds(STARTS, NOW)).toEqual({ from: new Date('2026-09-08T14:00:00Z'), to: new Date('2026-10-08T14:00:00Z') });
  });

  it('clamps the day to a short month and keeps the anchor day after it', () => {
    const jan31 = new Date('2026-01-31T00:00:00Z');
    expect(periodBounds(jan31, new Date('2026-03-01T00:00:00Z'))).toEqual({
      from: new Date('2026-02-28T00:00:00Z'),
      to: new Date('2026-03-31T00:00:00Z'),
    });
  });

  it('is the first period before the anchor has turned once', () => {
    expect(periodBounds(STARTS, new Date('2026-07-01T00:00:00Z'))).toEqual({ from: STARTS, to: new Date('2026-08-08T14:00:00Z') });
  });
});

describe('GrantPeriodService.forGrant', () => {
  it('answers this period live — the lifetime counter less the rolled days before it — and the last from rolled days', async () => {
    // Today (09-30) is not rolled yet; the live counter already holds it.
    const { service, asked } = build({
      sums: [day('2026-09-07', 1, 2), day('2026-09-08', 10, 20), day('2026-08-08', 5, 5), day('2026-08-01', 7, 0)],
    });
    const view = await inTenant(() => service.forGrant(USER, GRANT, NOW));

    // Before 09-08: 3 + 10 + 7 = 20; before 08-08: 7.
    expect(view.current).toMatchObject({ from: '2026-09-08T14:00:00.000Z', to: '2026-10-08T14:00:00.000Z', consumedBytes: (BigInt(3) * GIB - BigInt(20)).toString() });
    expect(view.previous).toMatchObject({ from: '2026-08-08T14:00:00.000Z', to: '2026-09-08T14:00:00.000Z', consumedBytes: '13' });
    expect(asked.grantWhere).toEqual({ id: GRANT, userId: USER });
  });

  it('has no previous period in the first month', async () => {
    const { service } = build({ grant: { id: GRANT, userId: USER, startsAt: new Date('2026-09-20T00:00:00Z'), billingMode: 'metered', trafficUnlimited: false, purchasedBytes: BigInt(0), consumedBytes: BigInt(0) } });
    const view = await inTenant(() => service.forGrant(USER, GRANT, NOW));
    expect(view.previous).toBeNull();
    expect(view.current.from).toBe('2026-09-20T00:00:00.000Z');
  });

  it("spends the Grant's usage charges less refunds, in the wallet's currency, per period", async () => {
    const { service, asked } = build({
      ledger: [
        { reasonType: 'traffic_consumption', direction: 'debit', amount: '2.50', createdAt: new Date('2026-09-10T00:00:00Z') },
        { reasonType: 'usage_charge', direction: 'debit', amount: '1.25', createdAt: new Date('2026-09-29T00:00:00Z') },
        { reasonType: 'traffic_refund', direction: 'credit', amount: '0.50', createdAt: new Date('2026-09-29T01:00:00Z') },
        { reasonType: 'traffic_consumption', direction: 'debit', amount: '9.00', createdAt: new Date('2026-09-01T00:00:00Z') },
        { reasonType: 'traffic_consumption', direction: 'debit', amount: '99', createdAt: new Date('2026-09-12T00:00:00Z'), currencyCode: 'EUR' },
      ],
    });
    const view = await inTenant(() => service.forGrant(USER, GRANT, NOW));

    expect(view.currencyCode).toBe('USD');
    expect(view.current.spent).toBe('3.25');
    expect(view.previous?.spent).toBe('9.00');
    expect(asked.ledger![0]).toMatchObject({ where: { walletId: WALLET, referenceId: GRANT } });
  });

  it('never answers a negative spend: a refund alone in a period is zero', async () => {
    const { service } = build({ ledger: [{ reasonType: 'traffic_refund', direction: 'credit', amount: '4', createdAt: new Date('2026-09-20T00:00:00Z') }] });
    expect((await inTenant(() => service.forGrant(USER, GRANT, NOW))).current.spent).toBe('0.00');
  });

  it('covers the bag left plus what the free balance and its own reserve buy, bounded by its cap', async () => {
    // Bag left 2 GiB; free 12 - 2 = 10, its reserve 1 -> 11 offered, the cap allows 5 -> 2 whole GiB at 2.5.
    let offered: [string, string] | null = null;
    const { service } = build({
      held: '1',
      room: (available, own) => {
        offered = [available.toString(), own.toString()];
        return D(5);
      },
    });
    const view = await inTenant(() => service.forGrant(USER, GRANT, NOW));
    expect(offered).toEqual(['11', '1']);
    expect(view.coversBytes).toBe((BigInt(4) * GIB).toString());
  });

  it('counts no reserve for a postpaid meter: its hold is for bytes already served', async () => {
    let offered: [string, string] | null = null;
    const { service } = build({
      held: '3',
      meter: { unitSize: GIB, unitPrice: D('2.5'), currencyCode: 'USD', mode: 'postpaid' },
      room: (available, own) => {
        offered = [available.toString(), own.toString()];
        return available;
      },
    });
    const view = await inTenant(() => service.forGrant(USER, GRANT, NOW));
    expect(offered).toEqual(['10', '0']);
    expect(view.coversBytes).toBe((BigInt(6) * GIB).toString());
  });

  it("covers the bag alone with no wallet, and says nothing when the rate is in another currency", async () => {
    const noWallet = build({ wallet: null });
    const a = await inTenant(() => noWallet.service.forGrant(USER, GRANT, NOW));
    expect(a).toMatchObject({ currencyCode: null, coversBytes: (BigInt(2) * GIB).toString() });
    expect(a.current.spent).toBe('0.00');

    const eur = build({ meter: { unitSize: GIB, unitPrice: D('2.5'), currencyCode: 'EUR', mode: 'prepaid' } });
    expect((await inTenant(() => eur.service.forGrant(USER, GRANT, NOW))).coversBytes).toBeNull();
  });

  it("refuses another user's Grant as missing and a Grant with no traffic meter as not metered", async () => {
    await expect(inTenant(() => build({ grant: null }).service.forGrant(USER, GRANT, NOW))).rejects.toMatchObject({ reason: 'grant_not_found' });
    await expect(inTenant(() => build({ meter: null }).service.forGrant(USER, GRANT, NOW))).rejects.toMatchObject({ reason: 'grant_not_metered' });
    const unlimited = build({ grant: { id: GRANT, userId: USER, startsAt: STARTS, billingMode: 'metered', trafficUnlimited: true, purchasedBytes: BigInt(0), consumedBytes: BigInt(0) } });
    await expect(inTenant(() => unlimited.service.forGrant(USER, GRANT, NOW))).rejects.toMatchObject({ reason: 'grant_not_metered' });
  });
});

describe('UserConfigsController.period', () => {
  const controllerWith = (forGrant: () => Promise<unknown>) =>
    new UserConfigsController({} as UserConfigsService, {} as GrantUsageService, { forGrant } as unknown as GrantPeriodService);

  it('is GET grants/:grantId/period under the GRANT_USAGE bucket, per user', () => {
    const handler = UserConfigsController.prototype.period;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('grants/:grantId/period');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(0);
    const limit = Reflect.getMetadata(RATE_LIMIT_KEY, handler) as RateLimitOptions;
    expect(limit.configKey).toBe('GRANT_USAGE_RATE_LIMIT');
    expect(limit.key(req(USER) as never)).toContain(RateLimitBucket.GRANT_USAGE);
  });

  it('maps a missing Grant to 404 and a package plan to 409', async () => {
    const { GrantPeriodRefused } = await import('./grant-period');
    await expect(controllerWith(async () => { throw new GrantPeriodRefused('grant_not_found', GRANT); }).period(GRANT, req(USER) as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controllerWith(async () => { throw new GrantPeriodRefused('grant_not_metered', GRANT); }).period(GRANT, req(USER) as never)).rejects.toBeInstanceOf(ConflictException);
  });
});
