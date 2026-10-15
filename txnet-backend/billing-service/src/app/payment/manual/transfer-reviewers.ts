import { Prisma, UserStatus } from '@prisma/client';
import { OutboxEventType, findKeyHolders } from '@txnet-backend/shared-core';

import { PAYMENT_CONFIRM_MANUAL } from '../deposit/manual-confirm.permission';

/** What a reviewer is told of a proof: which payment, and the amount it should show. */
export type ProofToReview = { ownerTenantId: string; paymentId: string; expectedAmountMinor: bigint; decimals: number; currencyCode: string };

/**
 * A payer sent a transfer's proof (F-805-b): one `billing.payment.transfer_proof_sent`
 * per active person of the **gateway's owner** who holds `payment.confirm_manual`
 * (`findKeyHolders`, ADR-0138: a role, a key given, a group; `*` included). The
 * notice sender keeps one person per event, as for the wheel's admins (F-707-e);
 * the bot's notice carries a button that opens the receipt. Run in the owner's
 * scope. Returns how many were told.
 */
export async function tellReviewers(tx: Prisma.TransactionClient, p: ProofToReview): Promise<number> {
  const reviewers = await findKeyHolders(tx, p.ownerTenantId, PAYMENT_CONFIRM_MANUAL, { deletedAt: null, status: UserStatus.active });
  // In the charge currency, as the payer was asked to send it — a decimal string, never a float (C-02).
  const amount = new Prisma.Decimal(p.expectedAmountMinor.toString()).dividedBy(new Prisma.Decimal(10).pow(p.decimals)).toFixed(p.decimals);
  for (const userId of reviewers) {
    await tx.outboxEvent.create({
      data: {
        aggregate: 'billing.payment',
        aggregateId: p.paymentId,
        type: OutboxEventType.TRANSFER_PROOF_SENT,
        payload: { tenantId: p.ownerTenantId, userId, paymentId: p.paymentId, amount, currencyCode: p.currencyCode },
      },
      select: { id: true },
    });
  }
  return reviewers.length;
}
