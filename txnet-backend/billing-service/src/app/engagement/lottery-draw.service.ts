import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { LotteryStatus, Prisma } from '@prisma/client';
import { lotteryListHash, lotteryPlaces, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { LotterySeedSeal, type SealedSeed } from './lottery-seed-seal';

/**
 * A lottery's draw (F-707-l, ADR-0111 point 5), run by the same
 * `lottery_close` tick right after the freeze (`close-due`).
 *
 * The freeze already fixed everything that decides the outcome: the tickets,
 * their hash and the sealed seed. The draw only applies the algorithm, in
 * `shared-core` so the verify page (F-707-n) runs the same code:
 * `lotteryPlaces` over the opened seed and the list hash.
 *
 * **One transaction per lottery.** The row is locked `FOR UPDATE` while
 * `frozen`; the list is read back and must hash to what the freeze recorded
 * (anything else is a list changed after the seed existed: refused, never
 * drawn over); the places are written; `drawnAt` and `publishedAt` are set
 * together — the seed, the hash and the result are public at once — and the
 * lottery moves to `drawn` last. A seed that cannot be opened (its KEK not
 * held) fails the lottery whole; it stays `frozen` and is drawn next minute.
 *
 * **Once.** A lottery leaves `frozen` only here, and a draw row's `drawnAt` is
 * set once (`lottery_draw_is_history`). No route starts, repeats or seeds a
 * draw: `close-due` is service-only.
 */

/** Lotteries drawn per run; the rest wait a minute. */
const DRAW_BATCH = 50;

export type DrawDueResult = { scanned: number; drawn: number; failed: number };

@Injectable()
export class LotteryDrawService {
  private readonly logger = new Logger(LotteryDrawService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly seeds: LotterySeedSeal,
  ) {}

  async drawDue(now: Date = new Date()): Promise<DrawDueResult> {
    // `frozen` is undrawn: `drawn` and `drawnAt` are written in one transaction.
    const due = await this.crossTenant.lottery.findMany({
      where: { status: LotteryStatus.frozen },
      select: { id: true, tenantId: true },
      orderBy: { closesAt: 'asc' },
      take: DRAW_BATCH,
    });
    const result: DrawDueResult = { scanned: due.length, drawn: 0, failed: 0 };
    for (const lot of due) {
      try {
        const drawn = await runWithTenant({ id: lot.tenantId }, () => tenantTransaction(this.prisma, (tx) => this.draw(tx, lot.id, now)));
        if (drawn) result.drawn += 1;
      } catch (e) {
        result.failed += 1;
        this.logger.warn(`drawing lottery ${lot.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  }

  /** `false`: another run got there first. */
  private async draw(tx: Prisma.TransactionClient, lotteryId: string, now: Date): Promise<boolean> {
    const [lot] = await tx.$queryRaw<Array<{ id: string; tenantId: string; reservesCount: number }>>`SELECT id, "tenantId", "reservesCount"
      FROM engagement.lottery WHERE id = ${lotteryId}::uuid AND status = 'frozen' FOR UPDATE`;
    if (!lot) return false;

    const draw = await tx.lotteryDraw.findUnique({ where: { lotteryId } });
    if (!draw || draw.drawnAt !== null) throw new Error(`lottery ${lotteryId} is frozen with no undrawn draw row`);

    const tickets = await tx.lotteryEntrant.findMany({
      where: { lotteryId, ticketNumber: { not: null } },
      select: { id: true, ticketNumber: true },
      orderBy: { ticketNumber: 'asc' },
    });
    const list = tickets.map((t) => ({ ticketNumber: t.ticketNumber as number, entrantId: t.id }));
    if (list.length !== draw.entrantCount || (await lotteryListHash(lotteryId, list)) !== draw.listHash) {
      throw new Error(`lottery ${lotteryId}: the ticket list does not hash to the one frozen; not drawn`);
    }

    const prizes = await tx.lotteryPrize.findMany({ where: { lotteryId }, select: { id: true, rank: true, winnersCount: true }, orderBy: { rank: 'asc' } });
    const places = await lotteryPlaces({
      seed: this.seeds.open(draw.seedSealed as unknown as SealedSeed),
      listHash: draw.listHash,
      entrantCount: list.length,
      prizes,
      reservesCount: lot.reservesCount,
    });

    const entrantOf = new Map(list.map((t) => [t.ticketNumber, t.entrantId]));
    const prizeOf = new Map(prizes.map((p) => [p.rank, p.id]));
    if (places.length > 0) {
      await tx.lotteryWinner.createMany({
        data: places.map((p) => ({
          id: randomUUID(),
          tenantId: lot.tenantId,
          lotteryId,
          entrantId: entrantOf.get(p.ticketNumber) as string,
          position: p.position,
          prizeId: p.prizeRank === null ? null : (prizeOf.get(p.prizeRank) as string),
        })),
      });
    }
    await tx.lotteryDraw.update({ where: { lotteryId }, data: { drawnAt: now, publishedAt: now } });
    const { count } = await tx.lottery.updateMany({ where: { id: lotteryId, status: LotteryStatus.frozen }, data: { status: LotteryStatus.drawn } });
    if (count !== 1) throw new Error(`lottery ${lotteryId} left frozen under its lock`);

    const winners = places.filter((p) => p.prizeRank !== null).length;
    this.logger.log(`lottery ${lotteryId} drawn: ${winners} winner(s), ${places.length - winners} reserve(s) from ${list.length} ticket(s)`);
    return true;
  }
}
