import type { Prisma, TransferReviewReason } from '@prisma/client';
import { signedObjectUrl, type UploadPolicy } from '@txnet-backend/shared-core';

import type { DestinationFields, ManualMethod } from './manual-method';
import { parseProof, type FieldRefused } from './manual-methods';

/**
 * A payer's proof of a manual transfer, and what the queue shows of it
 * (F-805-a, billing contract.manual-transfer.md "Proof and the queue"). The
 * rules only: the routes and the writes are `deposit/deposit-proof.service.ts`.
 */

/** The receipt screenshot: one image, private — only a signed URL serves it (ADR-0113). */
export const RECEIPT_POLICY: UploadPolicy = {
  types: ['image/jpeg', 'image/png', 'image/webp'],
  maxBytes: 5 * 1024 * 1024,
  visibility: 'private',
};

/** How long the queue's receipt link lives — a signed private file's five minutes (F-033-c). */
export const RECEIPT_URL_TTL_SEC = 5 * 60;

/** One receipt per payment: a second upload replaces the first, and the proof names exactly this key. */
export function receiptPath(paymentId: string): string {
  return `transfers/${paymentId}/receipt`;
}

/**
 * A payment whose payer sent their proof waits on a person, however late:
 * the expiry sweep never closes it, and the queue keeps it past its lookback.
 */
export const WITH_PROOF: Prisma.PaymentTransactionWhereInput = { transferDetail: { is: { proofSubmittedAt: { not: null } } } };
export const WITHOUT_PROOF: Prisma.PaymentTransactionWhereInput = { NOT: WITH_PROOF };

/** The external reference a proof carries — kept once per tenant in `transfer_tx_ref`. */
export type ProofRef = { network: string; txRef: string };

export type ProofCheck = { ok: true; fields: DestinationFields; ref: ProofRef | null } | { ok: false; refusals: FieldRefused[] };

/**
 * The gateway's `requiredProof`, each field checked by its kind, and the
 * receipt — when given — only this payment's own upload: a key the payer
 * typed could name any file of the tenant.
 */
export function checkProof(o: {
  method: ManualMethod;
  destination: DestinationFields;
  requiredProof: readonly string[];
  input: unknown;
  receiptKey: string;
}): ProofCheck {
  const parsed = parseProof(o.method, o.input, o.requiredProof);
  if ('refusals' in parsed) return { ok: false, refusals: parsed.refusals };
  const receipt = parsed.fields['receiptImage'];
  if (receipt !== undefined && receipt !== o.receiptKey) return { ok: false, refusals: [{ field: 'receiptImage', reason: 'invalid' }] };
  const txRef = parsed.fields[o.method.refProofField];
  const ref = txRef === undefined ? null : { network: o.method.refNetwork(o.destination), txRef: String(txRef) };
  return { ok: true, fields: parsed.fields, ref };
}

/** A person may send a proof back once (`reject` with `resubmit`), and only a proof that was sent. */
export function canReturnProof(detail: { proofSubmittedAt: Date | null; proofReturnedAt: Date | null }): boolean {
  return detail.proofSubmittedAt !== null && detail.proofReturnedAt === null;
}

/** What the manual-payments queue reads of a transfer's detail (`ManualConfirmService.list`). */
export type TransferDetailRow = {
  destination: { label: string; setting: { kind: string } };
  expectedAmountMinor: bigint;
  chargeCurrency: string;
  chargeDecimals: number;
  network: string | null;
  proof: unknown;
  proofSubmittedAt: Date | null;
  proofReturnedAt: Date | null;
  reviewReason: TransferReviewReason | null;
};

export type TransferView = {
  /** The method kind (`card_to_card`, …) — the panel draws the proof by it. */
  kind: string;
  destinationLabel: string;
  /** In `currencyCode`'s minor unit, a string as every amount on the wire. */
  expectedAmountMinor: string;
  currencyCode: string;
  decimals: number;
  /** A wallet's network as the seller wrote it — the panel links a tx hash to its explorer by it; null for a card. */
  network: string | null;
  proof: Record<string, unknown> | null;
  proofSubmittedAt: Date | null;
  reviewReason: TransferReviewReason | null;
  /** The receipt, signed for {@link RECEIPT_URL_TTL_SEC} on the reviewer's own Host; null with no image. */
  receiptUrl: string | null;
  receiptUrlExpiresAt: Date | null;
  /** Whether `reject` may still send the proof back. */
  canReturn: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The queue's view of one transfer: what to judge by, and a short-lived link to the receipt. */
export function transferViewOf(detail: TransferDetailRow, secret: string, now: Date): TransferView {
  const proof = isRecord(detail.proof) ? detail.proof : null;
  const key = typeof proof?.['receiptImage'] === 'string' ? proof['receiptImage'] : null;
  const signed = key ? signedObjectUrl({ key, fileName: 'receipt', ttlSec: RECEIPT_URL_TTL_SEC, secret, now }) : null;
  return {
    kind: detail.destination.setting.kind,
    destinationLabel: detail.destination.label,
    expectedAmountMinor: detail.expectedAmountMinor.toString(),
    currencyCode: detail.chargeCurrency,
    decimals: detail.chargeDecimals,
    network: detail.network,
    proof,
    proofSubmittedAt: detail.proofSubmittedAt,
    reviewReason: detail.reviewReason,
    receiptUrl: signed?.url ?? null,
    receiptUrlExpiresAt: signed?.expiresAt ?? null,
    canReturn: canReturnProof(detail),
  };
}
