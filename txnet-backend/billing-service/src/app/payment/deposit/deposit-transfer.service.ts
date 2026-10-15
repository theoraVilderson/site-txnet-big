import { Injectable } from '@nestjs/common';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import { transferRowsOf } from '../manual/transfer-rows';
import type { TransferBody } from '../manual/manual-transfer';

/** The transfer as the pay page re-reads it: the start's body, where the payment stands, and why it waits, if it does. */
export type TransferStatus = TransferBody & { status: string; reviewReason: string | null; proofSubmittedAt: Date | null };

/**
 * `GET /api/billing/deposit/:paymentId/transfer` (F-803-d): the `transfer` a
 * start answered, re-read for the payment's owner — the pay page reloads, or
 * opens from the history. The destination and the amount are the frozen
 * snapshot (F-803-a), never the destination as edited since; the kind,
 * required proof and mode are the gateway's now, which is what a proof is
 * checked against (F-805-a). Anyone else's payment, or one that is not a
 * transfer, is not found — the same answer, so neither is confirmed to exist.
 */
@Injectable()
export class DepositTransferService {
  constructor(private readonly prisma: PrismaService) {}

  read(userId: string, paymentId: string): Promise<TransferStatus | null> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await transferRowsOf(tx, paymentId);
      if (!rows || rows.payment.userId !== userId) return null;
      const { detail, setting } = rows;
      return {
        kind: setting.kind,
        destination: rows.destination,
        amountMinor: detail.expectedAmountMinor.toString(),
        currencyCode: detail.chargeCurrency,
        decimals: detail.chargeDecimals,
        windowEndsAt: detail.windowEndsAt,
        requiredProof: setting.requiredProof,
        confirmationMode: setting.confirmationMode,
        status: rows.payment.status,
        reviewReason: detail.reviewReason,
        proofSubmittedAt: detail.proofSubmittedAt,
      };
    });
  }
}
