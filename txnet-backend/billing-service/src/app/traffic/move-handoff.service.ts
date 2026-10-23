import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { OutboxEventType, runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { GRANT_AGGREGATE } from '../entitlement/delivered';
import { errorLine } from '../log-line';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionsService } from './config-actions';
import { MOVE_GRACE_DAYS, MOVE_HANDOFF_ACTOR, MOVE_HANDOFF_CAUSE } from './move-handoff';

/** Rows per sweep. A row not handled stays due, so this bounds a tick, not the backlog. */
const HANDOFF_BATCH_SIZE = 200;

const DAY_MS = 86_400_000;

/** A row a move left, with a step due: its replacement confirmed or gone, or its grace over. */
export type HandoffRow = {
  id: string;
  tenantId: string;
  userId: string;
  grantId: string;
  retireAt: Date | null;
  /** The replacement was found on its panel holding its desired state (`confirmedAt`). */
  confirmed: boolean;
  /** The replacement was retired before this row's grace began: the user deleted it, or the Grant went. */
  replacementGone: boolean;
};

export type HandoffDueResult = { scanned: number; told: number; retired: number; failed: number };

/**
 * The clock of a move's handoff (ADR-0160 decision 11, `move-handoff.ts`), on
 * `worker-service`'s `grant_group_fulfilment` tick. Two steps per row: once
 * the replacement is confirmed, the grace starts and the user is told the new
 * link or login is ready and when the old one stops; once the grace is over,
 * the old row retires and the open My services re-reads.
 *
 * The scan is cross-tenant and each write runs in the row's tenant. Safe to run
 * twice (ADR-0027): the grace is set only where it is unset — the notice rides
 * that write — and a retired row is never named again.
 */
@Injectable()
export class MoveHandoffService {
  private readonly logger = new Logger(MoveHandoffService.name);

  constructor(
    private readonly actions: ConfigActionsService,
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
  ) {}

  /** The grace is counted from this; a spec replaces it. */
  now: () => Date = () => new Date();

  async handoffDue(): Promise<HandoffDueResult> {
    const due = await this.crossTenant.$queryRaw<HandoffRow[]>`
      SELECT o."id", o."tenantId", o."userId", o."grantId", o."retireAt",
             n."confirmedAt" IS NOT NULL AS "confirmed", n."status" = 'retired' AS "replacementGone"
        FROM "network"."config" o
        JOIN "network"."config" n ON n."id" = o."supersededById"
       WHERE o."status" <> 'retired'
         AND (o."retireAt" <= now() AT TIME ZONE 'UTC'
              OR (o."retireAt" IS NULL AND (n."confirmedAt" IS NOT NULL OR n."status" = 'retired')))
       ORDER BY o."retireAt" ASC NULLS LAST, o."id"
       LIMIT ${HANDOFF_BATCH_SIZE}`;

    const result: HandoffDueResult = { scanned: due.length, told: 0, retired: 0, failed: 0 };
    const now = this.now();
    for (const row of due) {
      try {
        const ends = row.replacementGone || (row.retireAt !== null && row.retireAt <= now);
        const step = ends ? this.retire(row) : this.startGrace(row, now);
        if (await runWithTenant({ id: row.tenantId }, () => tenantTransaction(this.prisma, step))) result[ends ? 'retired' : 'told'] += 1;
      } catch (e) {
        // One row's failure — a user's own retire meanwhile — is its own; it is named again next tick.
        result.failed += 1;
        this.logger.warn(`handoff of config ${row.id} failed: ${errorLine(e)}`);
      }
    }
    if (result.told > 0 || result.retired > 0) this.logger.log(`move handoff: told ${result.told}, retired ${result.retired} old config(s)`);
    return result;
  }

  /** The grace starts and the user is told, in one write: a row whose grace is already set is told nothing. */
  private startGrace(row: HandoffRow, now: Date) {
    return async (tx: Prisma.TransactionClient): Promise<boolean> => {
      const retireAt = new Date(now.getTime() + MOVE_GRACE_DAYS * DAY_MS);
      const { count } = await tx.config.updateMany({ where: { id: row.id, retireAt: null }, data: { retireAt } });
      if (count === 0) return false;
      await tx.outboxEvent.create({
        data: {
          aggregate: GRANT_AGGREGATE,
          aggregateId: row.grantId,
          type: OutboxEventType.GRANT_CONFIG_MOVE_READY,
          // One move, one ledger row: the old config is the period.
          payload: { tenantId: row.tenantId, userId: row.userId, grantId: row.grantId, period: row.id, days: String(MOVE_GRACE_DAYS) },
        },
      });
      return true;
    };
  }

  /** The old row goes; the owner's open list re-reads (C-14) — a live push only, no "lines changed" notice. */
  private retire(row: HandoffRow) {
    return async (tx: Prisma.TransactionClient): Promise<boolean> => {
      await this.actions.retire(tx, { configId: row.id, actor: MOVE_HANDOFF_ACTOR });
      await tx.outboxEvent.create({
        data: {
          // As network's own capture announces it (`converge/postgres.go`), on the config.
          aggregate: 'network.config',
          aggregateId: row.id,
          type: OutboxEventType.GRANT_LINKS_CAPTURED,
          payload: { tenantId: row.tenantId, userId: row.userId, grantId: row.grantId, cause: MOVE_HANDOFF_CAUSE },
        },
      });
      return true;
    };
  }
}
