import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentStatus, Prisma, TransferReviewReason } from '@prisma/client';
import {
  ObjectRejected,
  ObjectStorage,
  objectKey,
  prismaStoredObjects,
  runWithTenant,
  tenantTransaction,
  type ObjectDriver,
  type VirusScanner,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../../prisma/prisma.service';
import type { FieldRefused } from '../manual/manual-methods';
import { RECEIPT_POLICY, checkProof, receiptPath } from '../manual/transfer-proof';
import { transferRowsOf, type TransferRows } from '../manual/transfer-rows';
import { announceOpenPayment } from './open-payment';

/** The DI tokens of the receipt's storage and scanner (`deposit-proof.module.ts`). */
export const PROOF_OBJECT_DRIVER = Symbol('PROOF_OBJECT_DRIVER');
export const PROOF_VIRUS_SCANNER = Symbol('PROOF_VIRUS_SCANNER');

export type ProofRejection =
  | 'transfer_not_found'
  /** The payment is no longer `pending`: settled, or expired past its grace. */
  | 'transfer_closed'
  /** One proof per payment, until a person sends it back (`reject` with `resubmit`). */
  | 'proof_already_sent'
  | 'invalid_proof'
  /** The proof names the receipt, and no upload of it exists. */
  | 'receipt_missing'
  /** Not a JPEG/PNG/WebP of at most 5 MB, or the scanner did not call it clean. */
  | 'receipt_rejected'
  /** The reference was already credited under this tenant (`transfer_tx_ref`). */
  | 'duplicate_ref';

export class ProofRefused extends Error {
  constructor(
    readonly reason: ProofRejection,
    readonly refusals?: readonly FieldRefused[],
  ) {
    super(reason);
    this.name = 'ProofRefused';
  }
}

/** The proof's answer: the payment waits on a person now. */
export type ProofAccepted = { paymentId: string; proofSubmittedAt: Date; reviewReason: TransferReviewReason };

/**
 * A manual transfer's proof, from its payer (F-805-a, billing
 * contract.manual-transfer.md "Proof and the queue"): the receipt upload, then
 * the proof that names it. The receipt is stored under the **gateway owner's**
 * prefix — the tenant whose staff reviews it, and so whose Host serves its
 * signed URL (`private-files` serves a Host's own keys only).
 */
@Injectable()
export class DepositProofService {
  private readonly logger = new Logger(DepositProofService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PROOF_OBJECT_DRIVER) private readonly driver: ObjectDriver,
    @Inject(PROOF_VIRUS_SCANNER) private readonly scanner: VirusScanner,
  ) {}

  /** Store the receipt, replacing an earlier upload of it; answers the key the proof must name. */
  async upload(userId: string, paymentId: string, file: { contentType: string; bytes: Buffer }): Promise<{ key: string }> {
    const rows = await tenantTransaction(this.prisma, (tx) => this.openTransfer(tx, userId, paymentId));
    const verdict = await this.scanner.scan(file.bytes);
    if (verdict.status !== 'clean') {
      this.logger.warn(`payment ${paymentId}: receipt refused by the scanner (${verdict.status})`);
      throw new ProofRefused('receipt_rejected', [{ field: 'receiptImage', reason: 'invalid' }]);
    }
    const owner = rows.setting.tenantId;
    try {
      const put = await runWithTenant({ id: owner }, () =>
        tenantTransaction(this.prisma, (tx) => new ObjectStorage(this.driver, prismaStoredObjects(tx)).put(RECEIPT_POLICY, receiptPath(paymentId), file.bytes, file.contentType)),
      );
      return { key: put.key };
    } catch (e) {
      if (e instanceof ObjectRejected) throw new ProofRefused('receipt_rejected', [{ field: 'receiptImage', reason: 'invalid' }]);
      throw e;
    }
  }

  /** Check and keep the proof; the payment joins the manual-payments queue (`proof_only`). */
  async submit(userId: string, paymentId: string, input: unknown): Promise<ProofAccepted> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await this.openTransfer(tx, userId, paymentId);
      if (!rows.method) throw new ProofRefused('transfer_not_found');
      const receiptKey = objectKey(rows.setting.tenantId, receiptPath(paymentId));
      const checked = checkProof({ method: rows.method, destination: rows.destination, requiredProof: rows.setting.requiredProof, input, receiptKey });
      if ('refusals' in checked) throw new ProofRefused('invalid_proof', checked.refusals);
      if (checked.fields['receiptImage'] !== undefined && !(await this.receiptExists(rows.setting.tenantId, receiptKey))) throw new ProofRefused('receipt_missing');
      if (checked.ref && (await tx.transferTxRef.findFirst({ where: checked.ref, select: { id: true } }))) throw new ProofRefused('duplicate_ref');

      const now = new Date();
      const { count } = await tx.paymentTransferDetail.updateMany({
        where: { paymentId, proofSubmittedAt: null },
        data: { proof: checked.fields as Prisma.InputJsonObject, proofSubmittedAt: now, reviewReason: TransferReviewReason.proof_only },
      });
      if (count !== 1) throw new ProofRefused('proof_already_sent');
      await announceOpenPayment(tx, paymentId);
      return { paymentId, proofSubmittedAt: now, reviewReason: TransferReviewReason.proof_only };
    });
  }

  /** The caller's own transfer, still open and awaiting its proof — else the refusal that says why not. */
  private async openTransfer(tx: Prisma.TransactionClient, userId: string, paymentId: string): Promise<TransferRows> {
    const rows = await transferRowsOf(tx, paymentId);
    // Anyone else's payment answers as a missing one, so neither is confirmed to exist.
    if (!rows || rows.payment.userId !== userId) throw new ProofRefused('transfer_not_found');
    if (rows.payment.status !== PaymentStatus.pending) throw new ProofRefused('transfer_closed');
    if (rows.detail.proofSubmittedAt) throw new ProofRefused('proof_already_sent');
    return rows;
  }

  /** The receipt's row, read in its owner's scope as it was written. */
  private receiptExists(owner: string, key: string): Promise<boolean> {
    return runWithTenant({ id: owner }, () =>
      tenantTransaction(this.prisma, async (tx) => (await new ObjectStorage(this.driver, prismaStoredObjects(tx)).stat(key)) !== null),
    );
  }
}
