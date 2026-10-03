import { Inject, Injectable, Optional } from '@nestjs/common';
import { LotteryStatus, LotteryWinnerDelivery } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { LOTTERY_CLOCK, LotteryActor, LotteryAdminRefused } from './lottery-admin.service';
import { ExclusionReason, candidateFacts, judgeCandidate, lotteryCandidates } from './lottery-close.service';

/**
 * What a tenant admin reads about one lottery beside its settings (F-707-o,
 * ADR-0111 point 5): `GET …/engagement/lotteries/:id/eligibility` and
 * `…/:id/winners`. Read only; neither moves a lottery.
 *
 * **The preview counts as the freeze will.** Before the freeze it runs the
 * close's own `lotteryCandidates` and `judgeCandidate` on what is true now —
 * an estimate, since accounts change until the close. It also judges every
 * user member, the most an `opt_in` lottery can reach. After the freeze it
 * reads the frozen list and judges nothing.
 *
 * **Winners only once drawn.** Before, `not_drawn`: an admin learns no place
 * sooner than the users do. The admin sees who holds each place; the public
 * result (F-707-m) never names a user.
 */

export type LotteryEligibility = {
  lotteryId: string;
  asOf: Date;
  /** `true` after the freeze: the frozen list, no longer an estimate. */
  final: boolean;
  /** User members of the group now, and how many pass the rules; `null` once final. */
  members: number | null;
  eligibleMembers: number | null;
  /** Who the close judges: every member (`automatic`) or the entrants (`opt_in`). */
  candidates: number;
  /** Tickets, or tickets if it closed now. */
  eligible: number;
  excluded: Partial<Record<ExclusionReason, number>>;
  skippedResellerCount: number;
};

export type LotteryWinnerPlace = {
  position: number;
  ticketNumber: number;
  /** `null` for an account no longer in the table. */
  user: { id: string; fullName: string; username: string | null } | null;
  prize: { rank: number; label: string } | null;
  delivery: LotteryWinnerDelivery;
  deliveredAt: Date | null;
  passedOnReason: string | null;
  replacesPosition: number | null;
};

export type LotteryWinners = {
  lotteryId: string;
  entrantCount: number;
  frozenAt: Date;
  drawnAt: Date;
  /** When the result went public; `null` until the delivery step publishes it. */
  publishedAt: Date | null;
  places: LotteryWinnerPlace[];
};

const FROZEN: LotteryStatus[] = [LotteryStatus.frozen, LotteryStatus.drawn];

function tally(reasons: Array<string | null>): Partial<Record<ExclusionReason, number>> {
  const out: Partial<Record<ExclusionReason, number>> = {};
  for (const r of reasons) if (r) out[r as ExclusionReason] = (out[r as ExclusionReason] ?? 0) + 1;
  return out;
}

@Injectable()
export class LotteryAdminReportService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(LOTTERY_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  eligibility(actor: LotteryActor, id: string): Promise<LotteryEligibility> {
    return tenantTransaction(this.prisma, async (tx) => {
      const lot = await tx.lottery.findFirst({
        where: { id, tenantId: actor.tenantId },
        select: { id: true, status: true, userGroupId: true, entryMode: true, requiresPhoneVerified: true, requiresMinAccountAgeHours: true },
      });
      if (!lot) throw new LotteryAdminRefused('lottery_not_found', id);
      const asOf = this.now();

      if (FROZEN.includes(lot.status)) {
        const [rows, draw] = await Promise.all([
          tx.lotteryEntrant.findMany({ where: { lotteryId: id }, select: { ticketNumber: true, excludedReason: true } }),
          tx.lotteryDraw.findUnique({ where: { lotteryId: id }, select: { skippedResellerCount: true, frozenAt: true } }),
        ]);
        return {
          lotteryId: id,
          asOf: draw?.frozenAt ?? asOf,
          final: true,
          members: null,
          eligibleMembers: null,
          candidates: rows.length,
          eligible: rows.filter((r) => r.ticketNumber !== null).length,
          excluded: tally(rows.filter((r) => r.ticketNumber === null).map((r) => r.excludedReason)),
          skippedResellerCount: draw?.skippedResellerCount ?? 0,
        };
      }

      const { candidates, userMembers, skippedResellerCount } = await lotteryCandidates(tx, lot);
      const facts = await candidateFacts(tx, actor.tenantId, [...new Set([...candidates.keys(), ...userMembers])], asOf);
      const reasons = [...candidates.values()].map((c) => judgeCandidate(c, facts.get(c.userId), lot, asOf));
      const eligibleMembers = [...userMembers].filter((u) => judgeCandidate({ inGroup: true }, facts.get(u), lot, asOf) === null).length;
      return {
        lotteryId: id,
        asOf,
        final: false,
        members: userMembers.size,
        eligibleMembers,
        candidates: reasons.length,
        eligible: reasons.filter((r) => r === null).length,
        excluded: tally(reasons),
        skippedResellerCount,
      };
    });
  }

  winners(actor: LotteryActor, id: string): Promise<LotteryWinners> {
    return tenantTransaction(this.prisma, async (tx) => {
      const lot = await tx.lottery.findFirst({ where: { id, tenantId: actor.tenantId }, select: { id: true, status: true } });
      if (!lot) throw new LotteryAdminRefused('lottery_not_found', id);
      const draw = lot.status === LotteryStatus.drawn ? await tx.lotteryDraw.findUnique({ where: { lotteryId: id } }) : null;
      if (!draw || !draw.drawnAt) throw new LotteryAdminRefused('not_drawn', lot.status);

      const [winners, entrants] = await Promise.all([
        tx.lotteryWinner.findMany({
          where: { lotteryId: id },
          select: { id: true, position: true, entrantId: true, delivery: true, deliveredAt: true, passedOnReason: true, replacesWinnerId: true, prize: { select: { rank: true, label: true } } },
          orderBy: { position: 'asc' },
        }),
        tx.lotteryEntrant.findMany({ where: { lotteryId: id, ticketNumber: { not: null } }, select: { id: true, userId: true, ticketNumber: true } }),
      ]);
      const entrantOf = new Map(entrants.map((e) => [e.id, e]));
      const userIds = [...new Set(winners.map((w) => entrantOf.get(w.entrantId)?.userId).filter((u): u is string => !!u))];
      const users = userIds.length ? await tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, username: true } }) : [];
      const userOf = new Map(users.map((u) => [u.id, u]));
      const positionOf = new Map(winners.map((w) => [w.id, w.position]));

      return {
        lotteryId: id,
        entrantCount: draw.entrantCount,
        frozenAt: draw.frozenAt,
        drawnAt: draw.drawnAt,
        publishedAt: draw.publishedAt,
        places: winners.map((w) => {
          const entrant = entrantOf.get(w.entrantId);
          const user = entrant && userOf.get(entrant.userId);
          return {
            position: w.position,
            ticketNumber: entrant?.ticketNumber as number,
            user: user ? { id: user.id, fullName: user.fullName, username: user.username ?? null } : null,
            prize: w.prize ? { rank: w.prize.rank, label: w.prize.label } : null,
            delivery: w.delivery,
            deliveredAt: w.deliveredAt,
            passedOnReason: w.passedOnReason,
            replacesPosition: w.replacesWinnerId ? (positionOf.get(w.replacesWinnerId) ?? null) : null,
          };
        }),
      };
    });
  }
}
