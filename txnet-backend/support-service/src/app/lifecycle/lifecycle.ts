import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConversationStatus, Prisma } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { ConversationRefused, SupportCaller } from '../conversations/refusal';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { SupportRealtime } from '../realtime/support-realtime';
import { applySla } from '../sla/sla';

/**
 * Auto-close, rating and reopen (F-033-k, user 2026-10-03).
 *
 * - **Auto-close.** A thread waiting on the user (`pending_user`) or
 *   `resolved`, with no word from the user for the tenant's
 *   `autoCloseAfterDays`, is closed by `closeIdle` — worker-service's clock,
 *   over the internal seam, across every tenant. One still waiting on an agent
 *   never closes by itself.
 * - **Rating.** The user rates a resolved or closed thread once, 1–5, with an
 *   optional comment. A later reopen does not clear it.
 * - **Reopen.** The user reopens a closed thread inside the tenant's
 *   `reopenWithinDays` of `closedAt`, back to whoever owed the next word:
 *   `open` if no agent ever answered, else `pending_agent`. Past it — or with
 *   0 days — they open a new one. A `resolved` thread needs no reopen: their
 *   next message does it (invariant 7).
 *
 * Both days are the platform's 7 unless the tenant set its own.
 */

export const PLATFORM_AUTO_CLOSE_DAYS = 7;
export const PLATFORM_REOPEN_DAYS = 7;
export const RATING_COMMENT_MAX = 1000;
/** One sweep closes at most this many; the next tick takes the rest. */
const SWEEP_LIMIT = 500;
const DAY_MS = 86_400_000;

export interface LifecyclePolicy {
  autoCloseAfterDays: number;
  reopenWithinDays: number;
  source: 'tenant' | 'platform';
}

export interface RatingView {
  score: number;
  comment: string | null;
  ratedAt: Date;
}

/** The realtime calls this needs. */
type StatusChannel = Pick<SupportRealtime, 'status' | 'tenant'>;

@Injectable()
export class SupportLifecycle {
  private readonly logger = new Logger(SupportLifecycle.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly config: ConfigService<EnvConfig, true>,
    @Inject(SupportRealtime) private readonly realtime: StatusChannel,
  ) {}

  async policy(tenantId: string): Promise<LifecyclePolicy> {
    return tenantTransaction(this.prisma, (tx) => policyOf(tx, tenantId));
  }

  /** `null` for both is the platform's again. */
  async setPolicy(tenantId: string, input: { autoCloseAfterDays: number | null; reopenWithinDays: number | null }): Promise<LifecyclePolicy> {
    if (input.autoCloseAfterDays === null && input.reopenWithinDays === null) {
      return tenantTransaction(this.prisma, async (tx) => {
        await tx.supportLifecyclePolicy.deleteMany({ where: { tenantId } });
        return policyOf(tx, tenantId);
      });
    }
    const autoClose = input.autoCloseAfterDays ?? PLATFORM_AUTO_CLOSE_DAYS;
    const reopen = input.reopenWithinDays ?? PLATFORM_REOPEN_DAYS;
    if (!within(autoClose, 1, 90) || !within(reopen, 0, 90)) throw new ConversationRefused('lifecycle_invalid');
    return tenantTransaction(this.prisma, async (tx) => {
      await tx.supportLifecyclePolicy.upsert({
        where: { tenantId },
        create: { tenantId, autoCloseAfterDays: autoClose, reopenWithinDays: reopen },
        update: { autoCloseAfterDays: autoClose, reopenWithinDays: reopen },
      });
      return policyOf(tx, tenantId);
    });
  }

  /**
   * Closes every thread idle on the user's side past its tenant's days. Safe to
   * run twice and from two replicas: each close re-checks the status and the
   * idle time under the row's lock, so a user who just wrote keeps their thread.
   */
  async closeIdle(now = new Date()): Promise<{ scanned: number; closed: number }> {
    const due = await this.crossTenant.$queryRaw<{ id: string }[]>`
      SELECT c.id FROM support.conversation c
       WHERE ${idle(now)}
       ORDER BY c."lastMessageAt"
       LIMIT ${SWEEP_LIMIT}`;

    let closed = 0;
    for (const { id } of due) {
      const tenantId = await this.crossTenant.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ tenantId: string }[]>`
          UPDATE support.conversation c
             SET status = 'closed'::support."ConversationStatus",
                 "closedAt" = ${now}, "updatedAt" = ${now}, "closedAutomatically" = true
           WHERE c.id = ${id}::uuid AND ${idle(now)}
          RETURNING c."tenantId"`;
        if (!row) return null;
        await applySla(tx, id, now, 'settled');
        return row.tenantId;
      });
      if (!tenantId) continue;
      closed += 1;
      await this.realtime.status(id, ConversationStatus.closed);
      await this.realtime.tenant(tenantId, id);
    }
    if (closed > 0) this.logger.log(`closed ${closed} idle conversation(s) of ${due.length} due`);
    return { scanned: due.length, closed };
  }

  /** Once, on the caller's own resolved or closed thread. */
  async rate(caller: SupportCaller, conversationId: string, input: { score: number; comment?: string }): Promise<RatingView> {
    if (!Number.isInteger(input.score) || !within(input.score, 1, 5)) throw new ConversationRefused('lifecycle_invalid');
    const comment = input.comment?.trim() ? input.comment.trim().slice(0, RATING_COMMENT_MAX) : null;
    return tenantTransaction(this.prisma, async (tx) => {
      const now = new Date();
      const [row] = await tx.$queryRaw<{ ratingScore: number; ratingComment: string | null; ratedAt: Date }[]>`
        UPDATE support.conversation
           SET "ratingScore" = ${input.score}, "ratingComment" = ${comment}, "ratedAt" = ${now}, "updatedAt" = ${now}
         WHERE id = ${conversationId}::uuid
           AND "userId" = ${caller.userId}::uuid
           AND status IN ('resolved', 'closed')
           AND "ratedAt" IS NULL
        RETURNING "ratingScore", "ratingComment", "ratedAt"`;
      if (row) return { score: row.ratingScore, comment: row.ratingComment, ratedAt: row.ratedAt };
      const own = await tx.supportConversation.findFirst({ where: { id: conversationId, userId: caller.userId }, select: { ratedAt: true } });
      if (!own) throw new ConversationRefused('not_found');
      throw new ConversationRefused(own.ratedAt ? 'already_rated' : 'not_finished');
    });
  }

  /** The caller's own closed thread, back in the queue — inside the tenant's window, and under the unfinished cap. */
  async reopen(caller: SupportCaller, conversationId: string): Promise<{ id: string; status: ConversationStatus }> {
    const result = await tenantTransaction(this.prisma, async (tx) => {
      const now = new Date();
      const conversation = await tx.supportConversation.findFirst({ where: { id: conversationId, userId: caller.userId } });
      if (!conversation) throw new ConversationRefused('not_found');
      if (conversation.status !== ConversationStatus.closed) throw new ConversationRefused('not_closed');
      const { reopenWithinDays } = await policyOf(tx, caller.tenantId);
      const closedAt = conversation.closedAt ?? conversation.updatedAt;
      if (now.getTime() - closedAt.getTime() > reopenWithinDays * DAY_MS) throw new ConversationRefused('reopen_expired');
      const unfinished = await tx.supportConversation.count({
        where: { userId: caller.userId, status: { in: [ConversationStatus.open, ConversationStatus.pending_user, ConversationStatus.pending_agent] } },
      });
      if (unfinished >= this.config.get('SUPPORT_UNFINISHED_MAX', { infer: true })) throw new ConversationRefused('too_many_unfinished');

      const status = conversation.firstResponseAt ? ConversationStatus.pending_agent : ConversationStatus.open;
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        UPDATE support.conversation
           SET status = ${status}::support."ConversationStatus",
               "closedAt" = NULL, "resolvedAt" = NULL, "closedAutomatically" = false, "updatedAt" = ${now}
         WHERE id = ${conversationId}::uuid AND status = 'closed'::support."ConversationStatus"
        RETURNING id`;
      if (!row) throw new ConversationRefused('not_closed');
      // The user is waiting again: a stopped resolution clock runs (F-033-h).
      await applySla(tx, conversationId, now, 'user_wrote');
      return { id: conversationId, status };
    });
    await this.realtime.status(conversationId, result.status);
    // Back in the queue, as if opened (RT-1-g).
    await this.realtime.tenant(caller.tenantId, conversationId);
    return result;
  }
}

/**
 * `c` waits on its user — `pending_user` or `resolved` — and has heard nothing
 * from them for its tenant's days. Idle is since the later of the last message
 * and the resolve: an agent resolving a quiet thread starts the count again.
 */
function idle(now: Date): Prisma.Sql {
  return Prisma.sql`c.status IN ('pending_user', 'resolved')
    AND GREATEST(c."lastMessageAt", COALESCE(c."resolvedAt", c."lastMessageAt"))
        < ${now}::timestamp - make_interval(days => COALESCE(
            (SELECT p."autoCloseAfterDays" FROM support.lifecycle_policy p WHERE p."tenantId" = c."tenantId"),
            ${PLATFORM_AUTO_CLOSE_DAYS})::int)`;
}

async function policyOf(tx: Prisma.TransactionClient, tenantId: string): Promise<LifecyclePolicy> {
  const own = await tx.supportLifecyclePolicy.findUnique({ where: { tenantId } });
  return own
    ? { autoCloseAfterDays: own.autoCloseAfterDays, reopenWithinDays: own.reopenWithinDays, source: 'tenant' }
    : { autoCloseAfterDays: PLATFORM_AUTO_CLOSE_DAYS, reopenWithinDays: PLATFORM_REOPEN_DAYS, source: 'platform' };
}

function within(n: number, min: number, max: number): boolean {
  return Number.isInteger(n) && n >= min && n <= max;
}
