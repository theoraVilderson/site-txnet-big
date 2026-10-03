import { Injectable } from '@nestjs/common';
import { LotteryStatus, LotteryWinnerDelivery, UserGroupMemberType } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { LotteryCaller, LotteryEntryRefused } from './lottery-entry.service';
import { LotterySeedSeal, type SealedSeed } from './lottery-seed-seal';

/**
 * A drawn lottery's public result (F-707-m, ADR-0111 point 5):
 * `GET /api/billing/lotteries/:id/result`.
 *
 * Everything the verify page (F-707-n) needs to redo the draw with
 * `shared-core`'s `lotteryListHash` and `lotteryPlaces`: the seed, opened
 * from its seal now that `publishedAt` is set; the ticket list
 * (`<ticket>:<entrantId>`, never a user id); its hash; the algorithm; and
 * every place with its prize and its delivery — a pass-on names its reason and
 * the place that took over. The caller's own row says which ticket is its.
 *
 * Shown to whoever may see the lottery (F-707-j rule 4: a user member of its
 * group, or anyone in its list); to anyone else it does not exist. Before
 * the draw is published there is nothing to show: `not_drawn`.
 */

export type LotteryResult = {
  lotteryId: string;
  title: string;
  algorithm: string;
  seed: string;
  listHash: string;
  entrantCount: number;
  frozenAt: Date;
  drawnAt: Date;
  tickets: Array<{ ticketNumber: number; entrantId: string }>;
  places: Array<{
    position: number;
    ticketNumber: number;
    prize: { rank: number; label: string } | null;
    delivery: LotteryWinnerDelivery;
    passedOnReason: string | null;
    replacesPosition: number | null;
  }>;
  mine: { entrantId: string; ticketNumber: number | null; excludedReason: string | null } | null;
};

@Injectable()
export class LotteryResultService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly seeds: LotterySeedSeal,
  ) {}

  result(caller: LotteryCaller, lotteryId: string): Promise<LotteryResult> {
    return tenantTransaction(this.prisma, async (tx) => {
      const lot = await tx.lottery.findFirst({
        where: { id: lotteryId, tenantId: caller.tenantId, publishedAt: { not: null } },
        select: { id: true, title: true, status: true, userGroupId: true },
      });
      const mine = lot && (await tx.lotteryEntrant.findFirst({ where: { lotteryId, userId: caller.userId }, select: { id: true, ticketNumber: true, excludedReason: true } }));
      const member =
        lot && !mine && (await tx.userGroupMember.findFirst({ where: { groupId: lot.userGroupId, userId: caller.userId, memberType: UserGroupMemberType.user }, select: { id: true } }));
      if (!lot || (!mine && !member)) throw new LotteryEntryRefused('lottery_not_found', lotteryId);
      if (lot.status !== LotteryStatus.drawn) throw new LotteryEntryRefused('not_drawn', lot.status);
      const draw = await tx.lotteryDraw.findUnique({ where: { lotteryId } });
      if (!draw || !draw.publishedAt || !draw.drawnAt) throw new LotteryEntryRefused('not_drawn', 'unpublished');

      const tickets = (
        await tx.lotteryEntrant.findMany({ where: { lotteryId, ticketNumber: { not: null } }, select: { id: true, ticketNumber: true }, orderBy: { ticketNumber: 'asc' } })
      ).map((t) => ({ ticketNumber: t.ticketNumber as number, entrantId: t.id }));
      const ticketOf = new Map(tickets.map((t) => [t.entrantId, t.ticketNumber]));
      const winners = await tx.lotteryWinner.findMany({
        where: { lotteryId },
        select: { id: true, position: true, entrantId: true, delivery: true, passedOnReason: true, replacesWinnerId: true, prize: { select: { rank: true, label: true } } },
        orderBy: { position: 'asc' },
      });
      const positionOf = new Map(winners.map((w) => [w.id, w.position]));

      return {
        lotteryId,
        title: lot.title,
        algorithm: draw.algorithm,
        seed: this.seeds.open(draw.seedSealed as unknown as SealedSeed),
        listHash: draw.listHash,
        entrantCount: draw.entrantCount,
        frozenAt: draw.frozenAt,
        drawnAt: draw.drawnAt,
        tickets,
        places: winners.map((w) => ({
          position: w.position,
          ticketNumber: ticketOf.get(w.entrantId) as number,
          prize: w.prize ? { rank: w.prize.rank, label: w.prize.label } : null,
          delivery: w.delivery,
          passedOnReason: w.passedOnReason,
          replacesPosition: w.replacesWinnerId ? (positionOf.get(w.replacesWinnerId) ?? null) : null,
        })),
        mine: mine ? { entrantId: mine.id, ticketNumber: mine.ticketNumber, excludedReason: mine.excludedReason } : null,
      };
    });
  }
}
