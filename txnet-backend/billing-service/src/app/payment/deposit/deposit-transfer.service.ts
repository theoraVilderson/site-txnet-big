import { Injectable } from '@nestjs/common';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import type { DestinationFields } from '../manual/manual-method';
import { settingWhere } from '../manual/manual-setting';
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
      const detail = await tx.paymentTransferDetail.findUnique({
        where: { paymentId },
        include: { payment: { select: { userId: true, status: true, gatewayId: true, tenantGatewayConfigId: true } } },
      });
      if (!detail || detail.payment.userId !== userId) return null;
      const { gatewayId, tenantGatewayConfigId } = detail.payment;
      const ref = gatewayId ? { source: 'platform' as const, id: gatewayId } : { source: 'tenant' as const, id: tenantGatewayConfigId ?? '' };
      const setting = await tx.manualGatewaySetting.findFirst({ where: settingWhere(ref), select: { kind: true, confirmationMode: true, requiredProof: true } });
      if (!setting) return null;
      return {
        kind: setting.kind,
        destination: detail.destinationSnapshot as DestinationFields,
        amountMinor: detail.expectedAmountMinor.toString(),
        currencyCode: detail.chargeCurrency,
        decimals: detail.chargeDecimals,
        windowEndsAt: detail.windowEndsAt,
        requiredProof: setting.requiredProof,
        confirmationMode: setting.confirmationMode,
        status: detail.payment.status,
        reviewReason: detail.reviewReason,
        proofSubmittedAt: detail.proofSubmittedAt,
      };
    });
  }
}
