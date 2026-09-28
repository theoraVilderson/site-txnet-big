import { Prisma } from '@prisma/client';
import { OutboxEventType, remainingLabel } from '@txnet-backend/shared-core';

import type { DurationChange } from '../entitlement/duration';
import { GRANT_AGGREGATE } from '../entitlement/delivered';
import type { TrafficChange } from '../entitlement/traffic';
import type { GrantAuditAction } from './grant-audit';

const DAY_MS = 86_400_000;

type AdminNotice = { type: OutboxEventType; params: Record<string, string> };

/**
 * What the user is told of an admin's act on their service (F-311-s), or
 * null for an act told nothing here: a speed cap or device limit (not in the
 * row), an issue or a renewal (told by the purchase's and the revival's own
 * notices). Only the act's direction and size — never the admin's reason,
 * which is staff's, and never a rotated link.
 */
export function adminNoticeOf(action: GrantAuditAction, result: unknown): AdminNotice | null {
  switch (action) {
    case 'grant_freeze':
      return { type: OutboxEventType.GRANT_ADMIN_FROZEN, params: {} };
    case 'grant_unfreeze':
      return { type: OutboxEventType.GRANT_ADMIN_UNFROZEN, params: {} };
    case 'grant_duration_change': {
      const { endsAtBefore, endsAtAfter } = result as DurationChange;
      const moved = endsAtAfter.getTime() - endsAtBefore.getTime();
      const days = String(Math.max(1, Math.round(Math.abs(moved) / DAY_MS)));
      return { type: moved >= 0 ? OutboxEventType.GRANT_ADMIN_DAYS_ADDED : OutboxEventType.GRANT_ADMIN_DAYS_REMOVED, params: { days } };
    }
    case 'grant_traffic_change':
    case 'grant_traffic_gift': {
      const { purchasedBytesBefore, purchasedBytesAfter } = result as TrafficChange;
      const moved = purchasedBytesAfter - purchasedBytesBefore;
      const amount = remainingLabel(moved < BigInt(0) ? -moved : moved);
      return { type: moved >= BigInt(0) ? OutboxEventType.GRANT_ADMIN_TRAFFIC_ADDED : OutboxEventType.GRANT_ADMIN_TRAFFIC_REMOVED, params: { amount } };
    }
    case 'grant_traffic_reset':
      return { type: OutboxEventType.GRANT_ADMIN_TRAFFIC_RESET, params: {} };
    case 'grant_delete':
      return { type: OutboxEventType.GRANT_ADMIN_DELETED, params: {} };
    case 'grant_link_rotate':
      return { type: OutboxEventType.GRANT_ADMIN_LINK_ROTATED, params: {} };
    default:
      return null;
  }
}

/**
 * The notice as a retention outbox row, in the act's transaction (ADR-0021).
 * `period` is the act's audit row: one act, one ledger row, told once —
 * however often an admin freezes the same Grant (notification `contract.retention.md`).
 */
export async function emitAdminNotice(tx: Prisma.TransactionClient, tenantId: string, grantId: string, auditId: string, notice: AdminNotice): Promise<void> {
  const grant = await tx.grant.findUnique({ where: { id: grantId }, select: { userId: true } });
  if (!grant) throw new Error(`grant ${grantId} was audited and is gone`);
  await tx.outboxEvent.create({
    data: {
      aggregate: GRANT_AGGREGATE,
      aggregateId: grantId,
      type: notice.type,
      payload: { tenantId, userId: grant.userId, grantId, period: auditId, ...notice.params },
    },
    select: { id: true },
  });
}
