import { Prisma } from '@prisma/client';
import { OutboxEventType } from '@txnet-backend/shared-core';

import { GRANT_AGGREGATE } from './delivered';

/**
 * The ways a Grant's service stops, each told by its own text
 * (F-601-b, spec 9.5) — because each is brought back by something else:
 *
 * - `ended`: its time ran out; a renewal moves the end and the planner reopens it;
 * - `volume_spent`: a prepaid bag is spent; a renewal adds bytes and revives it;
 * - `wallet_spent`: a metered bag is spent and the wallet cannot buy the next
 *   block; a **top-up** revives it (`reviveFundedGrants`). A metered renewal
 *   adds days alone and revives nothing, so this one never says "renew";
 * - `cap_reached`: the same stop, but the Grant's spending cap refused what the
 *   wallet could buy (F-118-t); raising or removing the cap revives it.
 */
export type CutOffType =
  | typeof OutboxEventType.GRANT_ENDED
  | typeof OutboxEventType.GRANT_VOLUME_SPENT
  | typeof OutboxEventType.GRANT_WALLET_SPENT
  | typeof OutboxEventType.GRANT_CAP_REACHED;

export type CutOffGrant = { grantId: string; tenantId: string; userId: string };

/**
 * Writes the cutoff event in the caller's transaction — the one that saw the
 * Grant stop, so the notice exists exactly when the stop does (ADR-0021).
 *
 * `period` is the ledger's name for this stop (notification invariant 14):
 * the end it closed on for `ended`, so a renewal opens a new one; the
 * suspension's instant otherwise, which a revival clears and the next
 * suspension writes anew.
 */
export async function emitCutOff(tx: Prisma.TransactionClient, grant: CutOffGrant, type: CutOffType, period: Date): Promise<void> {
  await tx.outboxEvent.create({
    data: {
      aggregate: GRANT_AGGREGATE,
      aggregateId: grant.grantId,
      type,
      payload: { tenantId: grant.tenantId, userId: grant.userId, grantId: grant.grantId, period: period.toISOString() },
    },
    select: { id: true },
  });
}
