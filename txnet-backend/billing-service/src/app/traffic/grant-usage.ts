import { Injectable } from '@nestjs/common';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionRefused } from './config-actions';

/** How many days the chart spans, today included. */
export const GRANT_USAGE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const ZERO = BigInt(0);

/** One UTC day of a Grant's traffic. Bytes as decimal strings: a day's sum passes 2^53 no sooner than a Grant does, but it can. */
export type GrantUsageDay = { date: string; uploadBytes: string; downloadBytes: string };

export type GrantUsageView = { from: string; to: string; days: GrantUsageDay[] };

/** `YYYY-MM-DD` of a UTC midnight — the shape `traffic_daily_aggregate.date` comes back in. */
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * A Grant's daily upload and download for the service page's chart (F-307-b),
 * summed over the Grant's configs from `traffic_daily_aggregate`.
 *
 * **That table has no `tenantId` and no policy of its own** (network
 * data-model.md), so the database fences nothing here: the aggregate is read
 * only by `configId`, and only for the configs of a Grant the gate's user owns.
 * Retired configs count — their bytes were spent against this Grant.
 *
 * The rollup re-rolls today on every run (network `contract.rollup.md`), so
 * today's figure is what the last run saw, not the live counter.
 */
@Injectable()
export class GrantUsageService {
  constructor(private readonly prisma: PrismaService) {}

  /** The last {@link GRANT_USAGE_DAYS} UTC days ending today, oldest first, one entry per day; a day with no row is zero. */
  dailyForGrant(userId: string, grantId: string, now: Date = new Date()): Promise<GrantUsageView> {
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const from = new Date(to.getTime() - (GRANT_USAGE_DAYS - 1) * DAY_MS);

    return tenantTransaction(this.prisma, async (tx) => {
      const grant = await tx.grant.findFirst({ where: { id: grantId, userId }, select: { id: true } });
      if (!grant) throw new ConfigActionRefused('grant_not_found', grantId);
      const configs = await tx.config.findMany({ where: { grantId, userId }, select: { id: true } });

      const byDay = new Map<string, { up: bigint; down: bigint }>();
      if (configs.length > 0) {
        const sums = await tx.trafficDailyAggregate.groupBy({
          by: ['date'],
          where: { configId: { in: configs.map((c) => c.id) }, date: { gte: from, lte: to } },
          _sum: { totalUploadBytes: true, totalDownloadBytes: true },
        });
        for (const s of sums) {
          byDay.set(isoDay(s.date), { up: s._sum.totalUploadBytes ?? ZERO, down: s._sum.totalDownloadBytes ?? ZERO });
        }
      }

      const days: GrantUsageDay[] = [];
      for (let i = 0; i < GRANT_USAGE_DAYS; i++) {
        const date = isoDay(new Date(from.getTime() + i * DAY_MS));
        const day = byDay.get(date);
        days.push({ date, uploadBytes: (day?.up ?? ZERO).toString(), downloadBytes: (day?.down ?? ZERO).toString() });
      }
      return { from: isoDay(from), to: isoDay(to), days };
    });
  }
}
