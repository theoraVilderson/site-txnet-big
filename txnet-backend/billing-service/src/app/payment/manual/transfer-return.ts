import { PaymentStatus, Prisma } from '@prisma/client';

import { announceOpenPayment } from '../deposit/open-payment';
import { transferWindow } from './manual-transfer';
import { canReturnProof } from './transfer-proof';
import { transferRowsOf } from './transfer-rows';

/** Who sent a proof back and why — the audit row's content (as `ManualConfirmation`). */
export type ProofReturn = { adminId: string; reason: string; ip: string; tenantId: string };

/**
 * A person sends the payer's proof back to be sent again (F-805-a: `reject`
 * with `resubmit`) — once. The proof is cleared, the seller's window reopens
 * from now with its grace, the payment stays `pending`, and the queue hears
 * it; a `payment_manual_return` audit row commits in the same transaction.
 * Answers whether this call returned it: false when the payment is not an
 * open transfer with a proof, or its proof was already returned once.
 */
export async function returnProof(tx: Prisma.TransactionClient, paymentId: string, by: ProofReturn, now = new Date()): Promise<boolean> {
  const rows = await transferRowsOf(tx, paymentId);
  if (!rows || rows.payment.status !== PaymentStatus.pending || !canReturnProof(rows.detail)) return false;
  const { windowEndsAt, expiresAt } = transferWindow(rows.setting, now);
  const { count } = await tx.paymentTransferDetail.updateMany({
    where: { paymentId, proofReturnedAt: null, proofSubmittedAt: { not: null } },
    data: { proof: Prisma.DbNull, proofSubmittedAt: null, reviewReason: null, proofReturnedAt: now, windowEndsAt },
  });
  if (count !== 1) return false;
  await tx.paymentTransaction.updateMany({ where: { id: paymentId, status: PaymentStatus.pending }, data: { expiresAt } });
  await tx.adminAuditLog.create({
    data: {
      tenantId: by.tenantId,
      adminId: by.adminId,
      action: 'payment_manual_return',
      targetEntityType: 'payment',
      targetEntityId: paymentId,
      oldValue: { proofSubmittedAt: rows.detail.proofSubmittedAt?.toISOString() ?? null },
      newValue: { windowEndsAt: windowEndsAt.toISOString(), reason: by.reason },
      adminIpAddress: by.ip,
    },
    select: { id: true },
  });
  await announceOpenPayment(tx, paymentId);
  return true;
}
