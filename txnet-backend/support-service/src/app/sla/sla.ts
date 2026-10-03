import { Injectable } from '@nestjs/common';
import { ConversationPriority, ConversationStatus, Prisma } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { readHours } from '../availability/availability';
import { addWorkingMinutes, workingMsBetween } from '../availability/working-hours';
import { ConversationRefused } from '../conversations/refusal';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SLA (F-033-h, catalog §11.3; user, 2026-10-03): a first-response and a
 * resolution target per tenant and priority — the platform's defaults
 * (`sla_policy.tenantId` NULL) unless the tenant set its own — counted in the
 * tenant's **working minutes** (F-033-g's schedule; none = the wall clock).
 *
 * Both due times are a pure function of the conversation, so any write can
 * recompute them: `createdAt` + the target, the resolution one pushed later by
 * the working time its clock has spent stopped. It stops while the thread
 * waits on the user (an agent replied) or is resolved, and the stopped time is
 * added when the user writes again. `slaDueAt` is the clock running now —
 * first response until one is given, then resolution; null while stopped —
 * and is what the agent queue orders by after priority (§11.5).
 */

export type SlaEvent = 'opened' | 'agent_replied' | 'user_wrote' | 'settled' | 'reprioritized';

export interface SlaTargets {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export interface SlaTargetView extends SlaTargets {
  priority: ConversationPriority;
  source: 'tenant' | 'platform';
}

/** What an agent sees of a conversation's clocks. */
export interface SlaView {
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  /** The clock running now; null while stopped (waiting on the user, or done). */
  dueAt: Date | null;
  firstResponseBreached: boolean;
  resolutionBreached: boolean;
}

/** If the defaults row were ever missing: the migration's `normal`. */
const FALLBACK: SlaTargets = { firstResponseMinutes: 240, resolutionMinutes: 1440 };
/** Thirty days of minutes — a target longer than that is a typo, not a promise. */
export const SLA_MINUTES_MAX = 43_200;

const PRIORITIES = Object.values(ConversationPriority);
const FINISHED: ConversationStatus[] = [ConversationStatus.resolved, ConversationStatus.closed];

/**
 * Recomputes one conversation's clocks after `event`, in the caller's
 * transaction — after the write that caused it, so status, `firstResponseAt`
 * and `priority` are already the new ones.
 */
export async function applySla(tx: Prisma.TransactionClient, conversationId: string, now: Date, event: SlaEvent): Promise<void> {
  const c = await tx.supportConversation.findUnique({ where: { id: conversationId } });
  if (!c) return;
  const [hours, targets] = await Promise.all([readHours(tx, c.tenantId), targetsFor(tx, c.tenantId, c.priority)]);

  let pausedAt = c.slaPausedAt;
  let pausedSeconds = c.slaPausedSeconds;
  if ((event === 'agent_replied' || event === 'settled') && !pausedAt) pausedAt = now;
  if (event === 'user_wrote' && pausedAt) {
    pausedSeconds += Math.round(workingMsBetween(hours, pausedAt, now) / 1000);
    pausedAt = null;
  }

  const firstResponseDueAt = addWorkingMinutes(hours, c.createdAt, targets.firstResponseMinutes);
  const resolutionDueAt = addWorkingMinutes(hours, c.createdAt, targets.resolutionMinutes + pausedSeconds / 60);
  const stopped = pausedAt !== null || FINISHED.includes(c.status);
  await tx.supportConversation.update({
    where: { id: conversationId },
    data: {
      firstResponseDueAt,
      resolutionDueAt,
      slaPausedAt: pausedAt,
      slaPausedSeconds: pausedSeconds,
      slaDueAt: stopped ? null : c.firstResponseAt ? resolutionDueAt : firstResponseDueAt,
    },
  });
}

/** The tenant's own target for `priority`, else the platform's. */
async function targetsFor(tx: Prisma.TransactionClient, tenantId: string, priority: ConversationPriority): Promise<SlaTargets> {
  const rows = await tx.supportSlaPolicy.findMany({ where: { priority, OR: [{ tenantId }, { tenantId: null }] } });
  const row = rows.find((r) => r.tenantId === tenantId) ?? rows.find((r) => r.tenantId === null);
  return row ? { firstResponseMinutes: row.firstResponseMinutes, resolutionMinutes: row.resolutionMinutes } : FALLBACK;
}

type ConversationRow = Prisma.SupportConversationGetPayload<object>;

/** Breached = the moment that answers the clock (or now, while it runs) is past its due. */
export function slaViewOf(c: ConversationRow, now: Date): SlaView {
  const answeredAt = c.firstResponseAt ?? now;
  const settledAt = c.resolvedAt ?? c.closedAt;
  const resolutionAt = FINISHED.includes(c.status) && settledAt ? settledAt : (c.slaPausedAt ?? now);
  return {
    firstResponseDueAt: c.firstResponseDueAt,
    resolutionDueAt: c.resolutionDueAt,
    dueAt: c.slaDueAt,
    firstResponseBreached: c.firstResponseDueAt !== null && answeredAt > c.firstResponseDueAt,
    resolutionBreached: c.resolutionDueAt !== null && resolutionAt > c.resolutionDueAt,
  };
}

/** The tenant's SLA settings (`support.manage`). */
@Injectable()
export class SupportSla {
  constructor(private readonly prisma: PrismaService) {}

  /** One row per priority, most urgent first: the tenant's own, or the platform's. */
  async targets(tenantId: string): Promise<SlaTargetView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.supportSlaPolicy.findMany({ where: { OR: [{ tenantId }, { tenantId: null }] } });
      return [...PRIORITIES].reverse().map((priority) => {
        const own = rows.find((r) => r.priority === priority && r.tenantId === tenantId);
        const row = own ?? rows.find((r) => r.priority === priority && r.tenantId === null);
        return {
          priority,
          firstResponseMinutes: row?.firstResponseMinutes ?? FALLBACK.firstResponseMinutes,
          resolutionMinutes: row?.resolutionMinutes ?? FALLBACK.resolutionMinutes,
          source: own ? 'tenant' : 'platform',
        };
      });
    });
  }

  /**
   * The tenant's own targets, whole: a priority listed is the tenant's from
   * now on, one left out goes back to the platform's. Applies to threads from
   * their next write; a target must answer before it resolves.
   */
  async setTargets(tenantId: string, input: (SlaTargets & { priority: ConversationPriority })[]): Promise<SlaTargetView[]> {
    const seen = new Set<ConversationPriority>();
    for (const t of input) {
      const valid =
        Number.isInteger(t.firstResponseMinutes) &&
        Number.isInteger(t.resolutionMinutes) &&
        t.firstResponseMinutes > 0 &&
        t.resolutionMinutes >= t.firstResponseMinutes &&
        t.resolutionMinutes <= SLA_MINUTES_MAX &&
        !seen.has(t.priority);
      if (!valid) throw new ConversationRefused('sla_invalid');
      seen.add(t.priority);
    }
    await tenantTransaction(this.prisma, async (tx) => {
      await tx.supportSlaPolicy.deleteMany({ where: { tenantId } });
      if (input.length > 0) await tx.supportSlaPolicy.createMany({ data: input.map((t) => ({ tenantId, ...t })) });
    });
    return this.targets(tenantId);
  }
}
