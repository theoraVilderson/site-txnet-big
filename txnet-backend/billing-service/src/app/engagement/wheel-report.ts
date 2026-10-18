import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma, SpinAttemptStatus, SpinPrizeType, UserStatus } from '@prisma/client';
import { OutboxEventType, findKeyHolders, tenantTransaction, moneyText, percentText } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { ENGAGEMENT_MANAGE } from './engagement-permission.guard';
import { addDays, isoDay, tenantDayOf, tenantZoneOf } from './tenant-day';
import { WheelActor } from './wheel-admin.service';

/**
 * The wheel's day, seen by its admins (F-707-e, ADR-0111 point 4): a report
 * per tenant day, and an alert when a day has spent 80% of its cap.
 */

/** The share of the day's cap that tells the admins. */
export const WHEEL_CAP_ALERT_SHARE = new Prisma.Decimal('0.8');

/** The outbox aggregate of a tenant's engagement. */
export const TENANT_ENGAGEMENT_AGGREGATE = 'tenant.engagement';

/**
 * Called by the spin, after it charged the day, in its transaction and under
 * the day row's lock — so the spin that crosses 80% is the only one that
 * tells, and a rolled-back spin tells nothing. Marks the day, then writes one
 * outbox event per active user of the tenant who holds `engagement.manage`
 * (`findKeyHolders`: by role, a key given, or a group; `*` included): the
 * notice sender keeps one person per event.
 * Returns how many were told.
 */
export async function alertCapCrossing(
  tx: Prisma.TransactionClient,
  a: { tenantId: string; tenantDay: Date; spent: Prisma.Decimal; cap: Prisma.Decimal; currencyCode: string; alertedAt: Date | null; at: Date },
): Promise<number> {
  if (a.alertedAt !== null || a.cap.lte(0) || a.spent.lt(a.cap.mul(WHEEL_CAP_ALERT_SHARE))) return 0;
  const marked = await tx.spinWheelDay.updateMany({ where: { tenantId: a.tenantId, tenantDay: a.tenantDay, capAlertedAt: null }, data: { capAlertedAt: a.at } });
  if (marked.count !== 1) return 0;
  // Everyone who holds the key, however (ADR-0138): a role, a key given, a group.
  const admins = await findKeyHolders(tx, a.tenantId, ENGAGEMENT_MANAGE, { deletedAt: null, status: UserStatus.active });
  for (const adminId of admins) {
    await tx.outboxEvent.create({
      data: {
        aggregate: TENANT_ENGAGEMENT_AGGREGATE,
        aggregateId: a.tenantId,
        type: OutboxEventType.TENANT_WHEEL_CAP_NEARING,
        payload: { tenantId: a.tenantId, userId: adminId, day: isoDay(a.tenantDay), spent: moneyText(a.spent), cap: moneyText(a.cap), currencyCode: a.currencyCode },
      },
      select: { id: true },
    });
  }
  return admins.length;
}

export type WheelReportRejection = 'invalid_range';

export class WheelReportRefused extends Error {
  constructor(readonly reason: WheelReportRejection) {
    super(reason);
    this.name = 'WheelReportRefused';
  }
}

export type WheelDayReport = {
  day: string;
  version: number;
  /** Awarded spins, a prize or nothing. */
  spins: number;
  /** Recorded refusals; never counted as spins. */
  refused: number;
  refusals: Record<string, number>;
  /** Awarded spins that gave nothing: an empty slot, or a pick over the cap or stock. */
  nothing: number;
  prizes: Array<{ prizeId: string; position: number; label: string; prizeType: SpinPrizeType; count: number; cost: string }>;
  costSpent: string;
  cap: string;
  currencyCode: string;
  capUsedPercent: string;
  alertedAt: string | null;
};

/** The longest range one read covers. */
export const WHEEL_REPORT_MAX_DAYS = 31;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayOf(v: string): Date {
  const d = new Date(`${v}T00:00:00Z`);
  if (!DAY_RE.test(v) || Number.isNaN(d.getTime())) throw new WheelReportRefused('invalid_range');
  return d;
}

export const WHEEL_REPORT_CLOCK = Symbol('WHEEL_REPORT_CLOCK');

@Injectable()
export class WheelReportService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(WHEEL_REPORT_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** Days from `from` to `to` (tenant days, inclusive); both default to today. Newest first; a day with no spin has no row. */
  report(actor: WheelActor, range: { from?: string; to?: string }): Promise<WheelDayReport[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const today = tenantDayOf(this.now(), await tenantZoneOf(tx, actor.tenantId));
      const to = range.to ? dayOf(range.to) : today;
      const from = range.from ? dayOf(range.from) : to;
      if (from > to || addDays(from, WHEEL_REPORT_MAX_DAYS) <= to) throw new WheelReportRefused('invalid_range');

      const where = { tenantId: actor.tenantId, tenantDay: { gte: from, lte: to } };
      const [days, groups] = await Promise.all([
        tx.spinWheelDay.findMany({
          where,
          select: { tenantDay: true, costSpent: true, spins: true, capAlertedAt: true, currencyCode: true, wheelConfig: { select: { version: true, dailyBudgetCapAmount: true } } },
          orderBy: { tenantDay: 'desc' },
        }),
        tx.spinWheelAttempt.groupBy({
          by: ['tenantDay', 'status', 'refusalReason', 'prizeAwardedId'],
          where,
          _count: { _all: true },
          _sum: { costAmount: true },
        }),
      ]);
      const prizeIds = [...new Set(groups.map((g) => g.prizeAwardedId).filter((id): id is string => id !== null))];
      const prizes = prizeIds.length
        ? await tx.spinWheelPrize.findMany({ where: { id: { in: prizeIds } }, select: { id: true, position: true, label: true, prizeType: true } })
        : [];

      return days.map((d) => {
        const key = isoDay(d.tenantDay);
        const mine = groups.filter((g) => isoDay(g.tenantDay) === key);
        const refusals: Record<string, number> = {};
        let spins = 0;
        let refused = 0;
        let nothing = 0;
        const given: WheelDayReport['prizes'] = [];
        for (const g of mine) {
          const n = g._count._all;
          if (g.status !== SpinAttemptStatus.awarded) {
            refused += n;
            const reason = g.refusalReason ?? g.status;
            refusals[reason] = (refusals[reason] ?? 0) + n;
            continue;
          }
          spins += n;
          const prize = prizes.find((p) => p.id === g.prizeAwardedId);
          if (!prize || prize.prizeType === SpinPrizeType.empty) {
            nothing += n;
            continue;
          }
          given.push({ prizeId: prize.id, position: prize.position, label: prize.label, prizeType: prize.prizeType, count: n, cost: moneyText(new Prisma.Decimal(g._sum.costAmount ?? 0)) });
        }
        const cap = new Prisma.Decimal(d.wheelConfig.dailyBudgetCapAmount);
        const spent = new Prisma.Decimal(d.costSpent);
        return {
          day: key,
          version: d.wheelConfig.version,
          spins,
          refused,
          refusals,
          nothing,
          prizes: given.sort((a, b) => a.position - b.position),
          costSpent: moneyText(spent),
          cap: moneyText(cap),
          currencyCode: d.currencyCode,
          capUsedPercent: percentText(cap.gt(0) ? spent.mul(100).div(cap) : new Prisma.Decimal(0)),
          alertedAt: d.capAlertedAt?.toISOString() ?? null,
        };
      });
    });
  }
}
