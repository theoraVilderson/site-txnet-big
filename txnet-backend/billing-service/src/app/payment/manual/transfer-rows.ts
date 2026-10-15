import type { Prisma } from '@prisma/client';

import type { DestinationFields, ManualMethod } from './manual-method';
import { manualMethod } from './manual-methods';
import { fieldsOf, settingWhere } from './manual-setting';

/**
 * One manual transfer as billing reads it to act on it (F-803-d, F-805-a):
 * the frozen detail, its payment, and its gateway's setting and method — the
 * one lookup the pay page, the proof routes and a confirmation share.
 */
export type TransferRows = {
  detail: {
    destinationSnapshot: Prisma.JsonValue;
    expectedAmountMinor: bigint;
    chargeCurrency: string;
    chargeDecimals: number;
    windowEndsAt: Date;
    proof: Prisma.JsonValue;
    proofSubmittedAt: Date | null;
    proofReturnedAt: Date | null;
    reviewReason: Prisma.PaymentTransferDetailGetPayload<object>['reviewReason'];
  };
  payment: { userId: string; status: string; tenantId: string | null };
  setting: { kind: string; confirmationMode: string; requiredProof: string[]; windowMinutes: number; confirmWithinMinutes: number | null; tenantId: string };
  /** Undefined only for a kind no longer registered — then nothing may be checked against it. */
  method: ManualMethod | undefined;
  destination: DestinationFields;
};

/** The transfer behind `paymentId` in the tenant in scope, or null when it is not one. */
export async function transferRowsOf(tx: Prisma.TransactionClient, paymentId: string): Promise<TransferRows | null> {
  const found = await tx.paymentTransferDetail.findUnique({
    where: { paymentId },
    include: { payment: { select: { userId: true, status: true, tenantId: true, gatewayId: true, tenantGatewayConfigId: true } } },
  });
  if (!found) return null;
  const { payment, ...detail } = found;
  const ref = payment.gatewayId ? { source: 'platform' as const, id: payment.gatewayId } : { source: 'tenant' as const, id: payment.tenantGatewayConfigId ?? '' };
  const setting = await tx.manualGatewaySetting.findFirst({
    where: settingWhere(ref),
    select: { kind: true, confirmationMode: true, requiredProof: true, windowMinutes: true, confirmWithinMinutes: true, tenantId: true },
  });
  if (!setting) return null;
  return { detail, payment, setting, method: manualMethod(setting.kind), destination: fieldsOf(detail.destinationSnapshot) };
}

/** The payer's reference in a proof — the kind's `refProofField` (a tracking code, a tx hash) — or null when it names none. */
function payerRefOf(rows: TransferRows): string | null {
  const proof = rows.detail.proof;
  if (!rows.method || typeof proof !== 'object' || proof === null || Array.isArray(proof)) return null;
  const ref = proof[rows.method.refProofField];
  return typeof ref === 'string' || typeof ref === 'number' ? String(ref) : null;
}

/**
 * The reference a person's confirmation records when they typed none (F-805-b):
 * the payer's own, off the proof — `reference: null` when the proof names none,
 * the receipt then being the evidence. Null when the payment is no transfer.
 */
export async function payerReference(tx: Prisma.TransactionClient, paymentId: string): Promise<{ reference: string | null } | null> {
  const rows = await transferRowsOf(tx, paymentId);
  return rows ? { reference: payerRefOf(rows) } : null;
}

/**
 * A confirmed transfer's reference, kept once per tenant (`transfer_tx_ref`,
 * F-805-a) in the crediting transaction: the unique index refuses a reference
 * another payment was credited under, and the credit rolls back with it. No
 * proof, or a proof without the kind's reference field, keeps nothing.
 */
export async function recordTransferRef(tx: Prisma.TransactionClient, paymentId: string): Promise<void> {
  const rows = await transferRowsOf(tx, paymentId);
  const txRef = rows ? payerRefOf(rows) : null;
  if (!rows?.method || !rows.payment.tenantId || txRef === null) return;
  await tx.transferTxRef.create({
    data: { tenantId: rows.payment.tenantId, paymentId, network: rows.method.refNetwork(rows.destination), txRef },
  });
}
