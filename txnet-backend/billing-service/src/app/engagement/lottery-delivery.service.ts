import { Injectable, Logger } from '@nestjs/common';
import { LotteryStatus, LotteryWinnerDelivery, Prisma, RewardSource, UserStatus } from '@prisma/client';
import { OutboxEventType, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { GrantService } from '../entitlement/grant';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { issueReward, RewardRefused, RewardIssued, PrizeServiceName } from './reward-issuer';

/**
 * A drawn lottery's prizes, given (F-707-m, ADR-0111 points 2, 5), by the
 * same `lottery_close` tick right after the draws.
 *
 * **One transaction per lottery**, its row locked `FOR UPDATE` while `drawn`.
 * Places with a prize and `pending` are taken in place order:
 *
 * - **The winner can no longer receive** — the account is deleted or not
 *   active (`inactive`), or a GB or days prize finds no active Grant to take
 *   it (`no_active_grant`; user, 2026-10-03: passed on at once, never queued
 *   for a purchase). The place is `passed_on` with its reason; the first
 *   reserve still unused (lowest place) takes the prize, naming the place it
 *   replaces, and is judged the same way. With no reserve left the prize
 *   stays unawarded, and the pass says why.
 * - **The refusal is the tenant's** — a coupon template gone, a variant that
 *   cannot be delivered, a reseller's funds or limits. A reserve would be
 *   refused the same, so nothing passes on: the place stays `pending` and is
 *   tried next minute (`held`).
 * - **Given** — through the reward issuer, as `source: lottery` with the
 *   place's row as reference (once, F-707-b rule 6), by the lottery's
 *   creator; `delivered`, and the winner is told (`engagement.lottery.won`).
 *
 * The issuer runs inside a savepoint, as the spin's does: a refusal undoes
 * whatever it wrote. Anything else fails the lottery whole; nothing given is
 * kept without its row, and it is tried next minute.
 */

/** Lotteries delivered per run; the rest wait a minute. */
const DELIVERY_BATCH = 50;

/** The outbox aggregate of a lottery's own events. */
export const LOTTERY_AGGREGATE = 'engagement.lottery';

export type PassedOnReason = 'inactive' | 'no_active_grant';

export type DeliverDueResult = { scanned: number; delivered: number; passedOn: number; held: number; failed: number };

type LockedLottery = { id: string; tenantId: string; title: string; createdByAdminId: string };
type Place = { id: string; position: number; prizeId: string | null; userId: string };

@Injectable()
export class LotteryDeliveryService {
  private readonly logger = new Logger(LotteryDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly grants: GrantService,
  ) {}

  async deliverDue(now: Date = new Date()): Promise<DeliverDueResult> {
    const due = await this.crossTenant.lottery.findMany({
      where: { status: LotteryStatus.drawn, winners: { some: { delivery: LotteryWinnerDelivery.pending, prizeId: { not: null } } } },
      select: { id: true, tenantId: true },
      orderBy: { closesAt: 'asc' },
      take: DELIVERY_BATCH,
    });
    const result: DeliverDueResult = { scanned: due.length, delivered: 0, passedOn: 0, held: 0, failed: 0 };
    for (const lot of due) {
      try {
        const counts = await runWithTenant({ id: lot.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.deliver(tx, lot.id, now)));
        result.delivered += counts.delivered;
        result.passedOn += counts.passedOn;
        result.held += counts.held;
      } catch (e) {
        result.failed += 1;
        this.logger.warn(`delivering lottery ${lot.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  }

  private async deliver(tx: Prisma.TransactionClient, lotteryId: string, now: Date) {
    const counts = { delivered: 0, passedOn: 0, held: 0 };
    const [lot] = await tx.$queryRaw<LockedLottery[]>`SELECT id, "tenantId", title, "createdByAdminId"
      FROM engagement.lottery WHERE id = ${lotteryId}::uuid AND status = 'drawn' FOR UPDATE`;
    if (!lot) return counts;

    const rows = await tx.lotteryWinner.findMany({
      where: { lotteryId },
      select: { id: true, position: true, prizeId: true, delivery: true, entrant: { select: { userId: true } } },
      orderBy: { position: 'asc' },
    });
    const pending = rows.filter((r) => r.delivery === LotteryWinnerDelivery.pending).map((r) => ({ id: r.id, position: r.position, prizeId: r.prizeId, userId: r.entrant.userId }));
    const queue: Place[] = pending.filter((p) => p.prizeId !== null);
    const reserves: Place[] = pending.filter((p) => p.prizeId === null);
    if (queue.length === 0) return counts;

    const prizes = new Map((await tx.lotteryPrize.findMany({ where: { lotteryId } })).map((p) => [p.id, p]));
    const users = new Map(
      (await tx.user.findMany({ where: { id: { in: pending.map((p) => p.userId) } }, select: { id: true, status: true, deletedAt: true } })).map((u) => [u.id, u]),
    );

    const passOn = async (place: Place, reason: PassedOnReason) => {
      await tx.lotteryWinner.update({ where: { id: place.id }, data: { delivery: LotteryWinnerDelivery.passed_on, passedOnReason: reason } });
      counts.passedOn += 1;
      const next = reserves.shift();
      if (!next) {
        this.logger.log(`lottery ${lotteryId}: place ${place.position} passed on (${reason}) with no reserve left`);
        return;
      }
      await tx.lotteryWinner.update({ where: { id: next.id }, data: { prizeId: place.prizeId, replacesWinnerId: place.id } });
      queue.push({ ...next, prizeId: place.prizeId });
    };

    for (let i = 0; i < queue.length; i += 1) {
      const place = queue[i];
      const user = users.get(place.userId);
      if (!user || user.status !== UserStatus.active || user.deletedAt !== null) {
        await passOn(place, 'inactive');
        continue;
      }
      const prize = prizes.get(place.prizeId as string);
      if (!prize) throw new Error(`lottery ${lotteryId}: place ${place.position} names a prize that is not the lottery's`);

      await tx.$executeRaw`SAVEPOINT lottery_reward`;
      let issued: RewardIssued;
      try {
        issued = await issueReward(tx, this.grants, {
          tenantId: lot.tenantId,
          userId: place.userId,
          source: RewardSource.lottery,
          referenceId: place.id,
          prize,
          actorUserId: lot.createdByAdminId,
          at: now,
        });
        await tx.$executeRaw`RELEASE SAVEPOINT lottery_reward`;
      } catch (e) {
        const refused = e instanceof RewardRefused || (e instanceof Error && e.name === 'EntitlementRefused');
        if (!refused) throw e;
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT lottery_reward`;
        if (e instanceof RewardRefused && (e.reason === 'no_active_grant' || e.reason === 'grant_not_eligible')) {
          await passOn(place, 'no_active_grant');
        } else {
          counts.held += 1;
          this.logger.warn(`lottery ${lotteryId}: place ${place.position} held, the tenant's refusal: ${e.message}`);
        }
        continue;
      }
      await tx.lotteryWinner.update({ where: { id: place.id }, data: { delivery: LotteryWinnerDelivery.delivered, deliveredAt: now } });
      await tx.outboxEvent.create({
        data: {
          aggregate: LOTTERY_AGGREGATE,
          aggregateId: lotteryId,
          type: OutboxEventType.LOTTERY_WON,
          payload: { tenantId: lot.tenantId, userId: place.userId, lotteryId, title: lot.title, prize: prize.label, rank: prize.rank, ...serviceParams(issued.service) },
        },
        select: { id: true },
      });
      counts.delivered += 1;
    }
    return counts;
  }
}

/** Where GB or days went, for the winner's notice to name (F-707-y): absent for any other prize, and empty parts left out. */
function serviceParams(service: PrizeServiceName | null): Record<string, string> {
  if (!service) return {};
  const parts = { serviceLabel: service.label, serviceSku: service.sku, serviceNameKey: service.nameKey };
  return Object.fromEntries(Object.entries(parts).filter((e): e is [string, string] => e[1] !== null));
}
