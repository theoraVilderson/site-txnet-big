import { Prisma } from '@prisma/client';
import { OutboxEventType, remainingLabel } from '@txnet-backend/shared-core';

import { GRANT_AGGREGATE } from '../entitlement/delivered';
import { GIB, bytesAffordable } from './block-purchase';

/**
 * A metered Grant's wallet running low (F-601-g, spec 9.3 `wallet.low_balance`).
 *
 * On a metered Grant the balance **is** the volume left (network
 * `contract.reserve.md`), so "low" is counted in bytes, not money: the
 * balance buys less than {@link LOW_BALANCE_BYTES} at the Grant's own locked
 * rate. Two Grants on one wallet at two rates cross at two balances, and each
 * is told its own.
 *
 * Seen by the block request after a purchase, in its transaction — the one
 * place a metered Grant's balance is read on every block, and the one moment
 * the user is still being served. A balance lowered by something else (a
 * product bought from the wallet) is seen by the Grant's next block.
 */

/** One GB at the Grant's rate (F-601-g, decided in the row): the platform default, one constant. */
export const LOW_BALANCE_BYTES = GIB;

export type LowBalanceGrant = {
  id: string;
  tenantId: string;
  userId: string;
  /** Its `vpn.traffic` meter's `unitPrice` (F-118-l); null = no rate. */
  rate: Prisma.Decimal | null;
  /** The crossing already told, or null when armed. */
  lowBalanceNoticeAt: Date | null;
};

/**
 * Tells the crossing once, or re-arms it — in the caller's transaction.
 *
 * - Under the threshold and armed: marks `lowBalanceNoticeAt`, and only the
 *   write that marks it emits `entitlement.grant.low_balance`, `period` its
 *   instant and `remaining` what the balance still buys. A racing purchase
 *   that finds it marked emits nothing; notification's ledger holds a
 *   redelivered event (invariant 14).
 * - At or over it and marked: clears it, so the next crossing is a new period.
 *   A top-up is seen here, by the next block, not by the top-up.
 * - Nothing when the balance buys no byte, or the Grant has no rate: a wallet
 *   that cannot buy the next block is the cutoff notice (F-601-b), never this.
 */
export async function noticeLowBalance(
  tx: Prisma.TransactionClient,
  grant: LowBalanceGrant,
  balance: Prisma.Decimal,
  now = new Date(),
): Promise<'told' | 'rearmed' | null> {
  if (grant.rate === null) return null;
  const affordable = bytesAffordable(grant.rate, balance);
  if (affordable >= LOW_BALANCE_BYTES) {
    if (grant.lowBalanceNoticeAt === null) return null;
    await tx.grant.updateMany({ where: { id: grant.id, lowBalanceNoticeAt: grant.lowBalanceNoticeAt }, data: { lowBalanceNoticeAt: null } });
    return 'rearmed';
  }
  if (affordable <= BigInt(0) || grant.lowBalanceNoticeAt !== null) return null;
  const marked = await tx.grant.updateMany({ where: { id: grant.id, lowBalanceNoticeAt: null }, data: { lowBalanceNoticeAt: now } });
  if (marked.count !== 1) return null;
  await tx.outboxEvent.create({
    data: {
      aggregate: GRANT_AGGREGATE,
      aggregateId: grant.id,
      type: OutboxEventType.GRANT_LOW_BALANCE,
      payload: { tenantId: grant.tenantId, userId: grant.userId, grantId: grant.id, period: now.toISOString(), remaining: remainingLabel(affordable) },
    },
    select: { id: true },
  });
  return 'told';
}
