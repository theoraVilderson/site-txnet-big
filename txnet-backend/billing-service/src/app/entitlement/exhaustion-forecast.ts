import { Injectable, Logger } from '@nestjs/common';
import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';
import { IDLE_CHECK_AFTER_MS, OutboxEventType, remainingLabel, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { GRANT_AGGREGATE } from './delivered';
import { runs } from './reactivated';

const DAY_MS = 86_400_000;

/** "Recent usage" (user, 2026-09-27): the last 72 h, which smooths one busy day and still sees a habit change within days. */
export const FORECAST_WINDOW_MS = 3 * DAY_MS;
/** Less of the window observed than this says nothing: one busy hour is not a rate. */
export const FORECAST_MIN_OBSERVED_MS = DAY_MS;
/** Told when the bytes left last this long or less at the recent rate (user, 2026-09-27). */
export const FORECAST_HORIZON_DAYS = 5;
/** Past this share of the period, the 95 % notice (F-601-d) is the urgent one and the forecast is not told. */
const FORECAST_LAST_LEVEL = 95;

/** Candidates one sweep reads per page. The scan pages by id: a Grant not due now is not moved on. */
const FORECAST_BATCH = 500;

export type ForecastGrant = {
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  usagePeriodFromBytes: bigint;
  consumedBytes: bigint;
  endsAt: Date | null;
  /** When it began to run — `activatedAt ?? startsAt`. The window never counts time before it. */
  ranSince: Date;
};

/**
 * Whether the bytes left run out within {@link FORECAST_HORIZON_DAYS} at the
 * rate of the last 72 h, and in how many whole days, rounded up (1 = within a
 * day). `windowBytes` is what the Grant's configs consumed in that window.
 *
 * Only a prepaid bag, as the usage thresholds (F-601-d): of the **period's**
 * bytes, below 95 %, not spent. Only when the bytes run out **before** the end
 * does: a Grant ending first hears its time notice (F-601-e), and "your volume
 * runs out" would be false. The rate is over the part of the window the Grant
 * ran, at least 24 h of it.
 */
export function exhaustionForecast(g: ForecastGrant, windowBytes: bigint, now: Date): { days: number; remainingBytes: bigint } | null {
  if (g.billingMode !== VariantBillingMode.prepaid || g.trafficUnlimited || !runs(g.endsAt, now)) return null;
  const bag = g.purchasedBytes - g.usagePeriodFromBytes;
  const remainingBytes = g.purchasedBytes - g.consumedBytes;
  if (bag <= BigInt(0) || remainingBytes <= BigInt(0)) return null;
  if ((g.consumedBytes - g.usagePeriodFromBytes) * BigInt(100) >= BigInt(FORECAST_LAST_LEVEL) * bag) return null;
  if (windowBytes <= BigInt(0)) return null;

  const observedMs = now.getTime() - Math.max(now.getTime() - FORECAST_WINDOW_MS, g.ranSince.getTime());
  if (observedMs < FORECAST_MIN_OBSERVED_MS) return null;
  // Integer to the millisecond: a bag passes 2^53 bytes long before a forecast needs a fraction of one.
  const msLeft = Number((remainingBytes * BigInt(observedMs)) / windowBytes);
  if (msLeft > FORECAST_HORIZON_DAYS * DAY_MS) return null;
  if (g.endsAt && now.getTime() + msLeft >= g.endsAt.getTime()) return null;
  return { days: Math.max(1, Math.ceil(msLeft / DAY_MS)), remainingBytes };
}

export type ForecastResult = { scanned: number; told: number };

/**
 * Exhaustion forecast (F-602, spec 9.5): "at this rate, your volume runs out
 * in N days" — a prepaid Grant whose last 72 h spend what is left of its
 * period within 5 days is told once per usage period; `worker-service` tells
 * the user (notification `contract.retention.md`).
 *
 * **The candidates are the Grants used in the last 72 h**, read off the idle
 * clock metering sets at every consuming charge (`idleCheckAt` = last use +
 * 7 days, F-601-l) — a Grant that consumed nothing in the window has no rate,
 * and its index already answers the question. A period already told is
 * skipped before its traffic is read.
 *
 * **Once per period**: `forecastNoticeFor` is the period (`usagePeriodStartedAt
 * ?? startsAt`) it was told for; the write is conditional on the value read and
 * on the period, so a second sweep or a renewal between read and write emits
 * nothing, and a renewal that adds bytes opens a period that can be told
 * again. A forecast not due writes nothing — the next hour asks again.
 *
 * Cross-tenant scan, per-tenant write, as `idle-notice.ts` does.
 */
@Injectable()
export class GrantExhaustionForecastService {
  private readonly logger = new Logger(GrantExhaustionForecastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  async noticeDue(now: Date = new Date()): Promise<ForecastResult> {
    // Used within the window <=> its last consuming charge set the idle clock past this.
    const usedSince = new Date(now.getTime() - FORECAST_WINDOW_MS + IDLE_CHECK_AFTER_MS);
    let scanned = 0;
    let told = 0;
    let cursor: string | undefined;
    for (;;) {
      const page = await this.crossTenant.grant.findMany({
        where: {
          status: GrantStatus.active,
          billingMode: VariantBillingMode.prepaid,
          trafficUnlimited: false,
          idleCheckAt: { gt: usedSince },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        select: { id: true, tenantId: true, startsAt: true, usagePeriodStartedAt: true, forecastNoticeFor: true },
        orderBy: { id: 'asc' },
        take: FORECAST_BATCH,
      });
      for (const grant of page) {
        if (grant.forecastNoticeFor?.getTime() === (grant.usagePeriodStartedAt ?? grant.startsAt).getTime()) continue;
        scanned += 1;
        const emitted = await runWithTenant({ id: grant.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.check(tx, grant.id, now)));
        if (emitted) told += 1;
      }
      if (page.length < FORECAST_BATCH) break;
      cursor = page[page.length - 1].id;
    }
    if (told > 0) this.logger.log(`forecast exhaustion for ${told} of ${scanned} Grant(s)`);
    return { scanned, told };
  }

  /** One Grant's forecast, in the caller's tenant transaction. Answers whether it emitted one. */
  async check(tx: Prisma.TransactionClient, grantId: string, now: Date): Promise<boolean> {
    const grant = await tx.grant.findFirst({
      where: { id: grantId, status: GrantStatus.active },
      select: {
        id: true,
        tenantId: true,
        userId: true,
        billingMode: true,
        trafficUnlimited: true,
        purchasedBytes: true,
        usagePeriodFromBytes: true,
        consumedBytes: true,
        startsAt: true,
        activatedAt: true,
        endsAt: true,
        usagePeriodStartedAt: true,
        forecastNoticeFor: true,
        // Retired configs too: their bytes were spent against this Grant.
        configs: { select: { id: true } },
      },
    });
    if (!grant || grant.configs.length === 0) return false;
    const period = grant.usagePeriodStartedAt ?? grant.startsAt;
    if (grant.forecastNoticeFor?.getTime() === period.getTime()) return false;

    const window = await tx.trafficRawLog.aggregate({
      where: { configId: { in: grant.configs.map((c) => c.id) }, recordedAt: { gt: new Date(now.getTime() - FORECAST_WINDOW_MS), lte: now } },
      _sum: { uploadBytes: true, downloadBytes: true },
    });
    const windowBytes = (window._sum.uploadBytes ?? BigInt(0)) + (window._sum.downloadBytes ?? BigInt(0));
    const forecast = exhaustionForecast({ ...grant, ranSince: grant.activatedAt ?? grant.startsAt }, windowBytes, now);
    if (!forecast) return false;

    const marked = await tx.grant.updateMany({
      where: { id: grant.id, status: GrantStatus.active, forecastNoticeFor: grant.forecastNoticeFor, usagePeriodStartedAt: grant.usagePeriodStartedAt },
      data: { forecastNoticeFor: period },
    });
    if (marked.count !== 1) return false;

    await tx.outboxEvent.create({
      data: {
        aggregate: GRANT_AGGREGATE,
        aggregateId: grant.id,
        type: forecast.days === 1 ? OutboxEventType.GRANT_RUNS_OUT_WITHIN_A_DAY : OutboxEventType.GRANT_RUNS_OUT_SOON,
        payload: {
          tenantId: grant.tenantId,
          userId: grant.userId,
          grantId: grant.id,
          period: period.toISOString(),
          days: String(forecast.days),
          remaining: remainingLabel(forecast.remainingBytes),
        },
      },
      select: { id: true },
    });
    return true;
  }
}
