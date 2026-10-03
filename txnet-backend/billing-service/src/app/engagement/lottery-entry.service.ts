import { Inject, Injectable, Optional } from '@nestjs/common';
import { LotteryEntryMode, LotteryStatus, Prisma, SpinPrizeType, UserGroupMemberType } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/**
 * A user's lotteries (F-707-j, ADR-0111 point 6): `/api/billing/lotteries`.
 *
 * **Entry is free, once.** A user member of the lottery's group joins an
 * `opt_in` lottery while it is open — published and before `closesAt` — and
 * may leave in the same window. The database's unique (lottery, user) makes a
 * second entry impossible; a retried join answers the first one (`replay`).
 * An `automatic` lottery takes every eligible member at the close (F-707-k),
 * so there is nothing to join.
 *
 * **The list cannot move under the freeze.** A join or a leave reads the
 * lottery row `FOR SHARE`; the close job takes it `FOR UPDATE` before it
 * numbers the tickets, so an entry is either in the frozen list or refused
 * `closed` — never written after the tickets are. The database refuses an
 * entrant write once the lottery leaves `published` (`lottery_frozen`) as
 * the last line.
 *
 * Eligibility (phone, account age, flags, the fingerprint rule) is judged at
 * the close, not here: what counts is what is true when the list is frozen.
 * A user who is not in the group is told nothing exists (`lottery_not_found`),
 * as for a draft.
 */

export type LotteryEntryRejection = 'lottery_not_found' | 'not_opt_in' | 'closed';

export class LotteryEntryRefused extends Error {
  constructor(
    readonly reason: LotteryEntryRejection,
    readonly detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'LotteryEntryRefused';
  }
}

export type LotteryCaller = { userId: string; tenantId: string };

export type LotteryEntryResult = { lotteryId: string; joined: true; optedInAt: Date | null; replay: boolean } | { lotteryId: string; joined: false; replay: boolean };

export type UserLotteryView = {
  id: string;
  title: string;
  description: string | null;
  entryMode: LotteryEntryMode;
  status: LotteryStatus;
  closesAt: Date;
  publishedAt: Date | null;
  /** Public, when cancelled (point 5). */
  cancelReason: string | null;
  /** Published and before its close time: a join or a leave is accepted now. */
  open: boolean;
  prizes: Array<{ rank: number; label: string; prizeType: SpinPrizeType; prizeValue: string; winnersCount: number }>;
  /** The caller's row in the entrant list, if it has one: an opt-in while open; a ticket or an exclusion after the freeze. */
  entry: { optedInAt: Date | null; ticketNumber: number | null; excludedReason: string | null } | null;
};

type LockedLottery = { id: string; status: LotteryStatus; entryMode: LotteryEntryMode; closesAt: Date; userGroupId: string };

/** The clock, injectable so a spec can stand at a close time. */
export const LOTTERY_ENTRY_CLOCK = Symbol('LOTTERY_ENTRY_CLOCK');

/** A user's page lists this many, newest close time first. */
const LIST_LIMIT = 30;

const isOpen = (l: { status: LotteryStatus; closesAt: Date }, now: Date) => l.status === LotteryStatus.published && now.getTime() < l.closesAt.getTime();

@Injectable()
export class LotteryEntryService {
  private readonly now: () => Date;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(LOTTERY_ENTRY_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** The published lotteries of the caller's groups, and every lottery it holds an entrant row in. Never a draft. */
  list(caller: LotteryCaller): Promise<UserLotteryView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const now = this.now();
      const groups = await tx.userGroupMember.findMany({ where: { userId: caller.userId, memberType: UserGroupMemberType.user }, select: { groupId: true } });
      const entries = await tx.lotteryEntrant.findMany({
        where: { tenantId: caller.tenantId, userId: caller.userId },
        select: { lotteryId: true, optedInAt: true, ticketNumber: true, excludedReason: true },
      });
      const rows = await tx.lottery.findMany({
        where: {
          tenantId: caller.tenantId,
          publishedAt: { not: null },
          OR: [{ userGroupId: { in: groups.map((g) => g.groupId) } }, { id: { in: entries.map((e) => e.lotteryId) } }],
        },
        include: { prizes: true },
        orderBy: { closesAt: 'desc' },
        take: LIST_LIMIT,
      });
      const mine = new Map(entries.map((e) => [e.lotteryId, e]));
      return rows.map((l) => {
        const e = mine.get(l.id);
        return {
          id: l.id,
          title: l.title,
          description: l.description,
          entryMode: l.entryMode,
          status: l.status,
          closesAt: l.closesAt,
          publishedAt: l.publishedAt,
          cancelReason: l.cancelReason,
          open: isOpen(l, now),
          prizes: [...l.prizes]
            .sort((a, b) => a.rank - b.rank)
            .map((p) => ({ rank: p.rank, label: p.label, prizeType: p.prizeType, prizeValue: new Prisma.Decimal(p.prizeValue).toFixed(2), winnersCount: p.winnersCount })),
          entry: e ? { optedInAt: e.optedInAt, ticketNumber: e.ticketNumber, excludedReason: e.excludedReason } : null,
        };
      });
    });
  }

  join(caller: LotteryCaller, lotteryId: string): Promise<LotteryEntryResult> {
    return tenantTransaction(this.prisma, async (tx) => {
      const now = this.now();
      const lot = await this.lock(tx, caller, lotteryId);
      if (!lot || !(await this.isMember(tx, lot, caller.userId))) throw new LotteryEntryRefused('lottery_not_found', lotteryId);
      if (lot.entryMode !== LotteryEntryMode.opt_in) throw new LotteryEntryRefused('not_opt_in');
      if (!isOpen(lot, now)) throw new LotteryEntryRefused('closed', lot.status);

      const existing = await this.entryOf(tx, lotteryId, caller.userId);
      if (existing) return { lotteryId, joined: true, optedInAt: existing.optedInAt, replay: true };
      try {
        await tx.lotteryEntrant.create({ data: { tenantId: caller.tenantId, lotteryId, userId: caller.userId, optedInAt: now } });
      } catch (e) {
        // A retry of this very join committed first: the unique kept one row, answer it.
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        const kept = await this.entryOf(tx, lotteryId, caller.userId);
        return { lotteryId, joined: true, optedInAt: kept?.optedInAt ?? null, replay: true };
      }
      return { lotteryId, joined: true, optedInAt: now, replay: false };
    });
  }

  /** While open. An entrant taken out of the group may still leave; anyone else is told nothing exists. */
  leave(caller: LotteryCaller, lotteryId: string): Promise<LotteryEntryResult> {
    return tenantTransaction(this.prisma, async (tx) => {
      const lot = await this.lock(tx, caller, lotteryId);
      const existing = lot && (await this.entryOf(tx, lotteryId, caller.userId));
      if (!lot || (!existing && !(await this.isMember(tx, lot, caller.userId)))) throw new LotteryEntryRefused('lottery_not_found', lotteryId);
      if (lot.entryMode !== LotteryEntryMode.opt_in) throw new LotteryEntryRefused('not_opt_in');
      if (!isOpen(lot, this.now())) throw new LotteryEntryRefused('closed', lot.status);
      const { count } = await tx.lotteryEntrant.deleteMany({ where: { lotteryId, userId: caller.userId } });
      return { lotteryId, joined: false, replay: count === 0 };
    });
  }

  /** The lottery row, shared-locked: the freeze (`FOR UPDATE`) waits for this entry, or this entry for the freeze. A draft is not there. */
  private async lock(tx: Prisma.TransactionClient, caller: LotteryCaller, lotteryId: string): Promise<LockedLottery | null> {
    const [row] = await tx.$queryRaw<LockedLottery[]>`SELECT id, status, "entryMode", "closesAt", "userGroupId" FROM engagement.lottery
      WHERE id = ${lotteryId}::uuid AND "tenantId" = ${caller.tenantId}::uuid FOR SHARE`;
    return row && row.status !== LotteryStatus.draft ? row : null;
  }

  private async isMember(tx: Prisma.TransactionClient, lot: LockedLottery, userId: string): Promise<boolean> {
    const m = await tx.userGroupMember.findFirst({ where: { groupId: lot.userGroupId, userId, memberType: UserGroupMemberType.user }, select: { id: true } });
    return m !== null;
  }

  private entryOf(tx: Prisma.TransactionClient, lotteryId: string, userId: string) {
    return tx.lotteryEntrant.findFirst({ where: { lotteryId, userId }, select: { optedInAt: true } });
  }
}
