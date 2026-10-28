/**
 * A payer's proof of a manual transfer (F-805-a, LIVE-1-b).
 *
 * What would break silently here, and nowhere else:
 *  - **no transaction inside another** (C-29): the receipt's row is read in the
 *    gateway owner's scope, which is its own transaction. Opened while the
 *    proof's transaction is still open, it waits for a second pool connection
 *    while holding the first — a burst of proofs then holds every connection
 *    and each one runs out its 5 s clock (LIVE-1-b, 2026-10-26: a 500 to the
 *    buyer with the proof stored);
 *  - the receipt is looked up under the **owner's** tenant, not the payer's;
 *  - a proof naming no stored receipt is refused, and nothing is written;
 *  - a proof that lost the race to another is `proof_already_sent`.
 */
import { PaymentStatus } from '@prisma/client';
import { TenantContext, objectKey, runWithTenant } from '@txnet-backend/shared-core';

import { receiptPath } from '../manual/transfer-proof';
import { openPaymentFakes } from '../../../test-support/open-payment.fake';
import { DepositProofService } from './deposit-proof.service';

const OWNER = '00000000-0000-4000-8000-000000000001';
const RESELLER = '11111111-1111-4111-8111-111111111111';
const USER = '44444444-4444-4444-8444-444444444444';
const GATEWAY = '99999999-9999-4999-8999-999999999999';
const PAYMENT = '77777777-7777-4777-8777-777777777777';

const RECEIPT_KEY = objectKey(OWNER, receiptPath(PAYMENT));
const PROOF = { receiptImage: RECEIPT_KEY, trackingCode: '12345678' };

function build(setup: { stored?: boolean; won?: boolean } = {}) {
  const { stored = true, won = true } = setup;
  const calls = {
    /** The deepest `$transaction` nesting seen: 1 is every transaction on its own. */
    depth: 0,
    maxDepth: 0,
    receiptReads: [] as Array<string | null>,
    proofWrites: 0,
  };
  const open = openPaymentFakes();
  const tx = {
    $executeRaw: async () => 0,
    tenant: open.tenant,
    outboxEvent: open.outboxEvent(),
    paymentTransaction: { findUnique: open.findUnique },
    paymentTransferDetail: {
      findUnique: async () => ({
        destinationSnapshot: { cardNumber: '6037991234567890', holderName: 'A. Rahimi', bankId: 'melli' },
        expectedAmountMinor: BigInt(12_500_000),
        chargeCurrency: 'IRR',
        chargeDecimals: 0,
        windowEndsAt: new Date(),
        proof: null,
        proofSubmittedAt: null,
        proofReturnedAt: null,
        reviewReason: null,
        payment: { userId: USER, status: PaymentStatus.pending, tenantId: RESELLER, gatewayId: GATEWAY, tenantGatewayConfigId: null },
      }),
      updateMany: async () => (calls.proofWrites++, { count: won ? 1 : 0 }),
    },
    manualGatewaySetting: {
      findFirst: async () => ({ kind: 'card_to_card', confirmationMode: 'manual_admin_required', requiredProof: ['receiptImage', 'trackingCode'], windowMinutes: 30, confirmWithinMinutes: null, tenantId: OWNER }),
    },
    transferTxRef: { findFirst: async () => null },
    storedObject: {
      findUnique: async ({ where }: { where: { key: string; tenantId: string } }) => {
        calls.receiptReads.push(TenantContext.currentOrNull()?.id ?? null);
        return stored ? { key: where.key, tenantId: where.tenantId, contentType: 'image/png', size: 1, sha256: 'x', private: true } : null;
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => {
      calls.depth++;
      calls.maxDepth = Math.max(calls.maxDepth, calls.depth);
      try {
        return await fn(tx);
      } finally {
        calls.depth--;
      }
    },
  };
  const service = new DepositProofService(prisma as never, {} as never, {} as never);
  // In the payer's tenant, as `identity.middleware.ts` runs the route.
  const submit = (input: unknown) => runWithTenant({ id: RESELLER }, () => service.submit(USER, PAYMENT, input));
  return { submit, calls };
}

describe('DepositProofService.submit', () => {
  it('opens no transaction while another is open', async () => {
    const { submit, calls } = build();
    await submit(PROOF);
    expect(calls.maxDepth).toBe(1);
  });

  it('keeps the proof, reading the receipt in the gateway owner’s scope', async () => {
    const { submit, calls } = build();
    await expect(submit(PROOF)).resolves.toMatchObject({ paymentId: PAYMENT, reviewReason: 'proof_only' });
    expect(calls.receiptReads).toEqual([OWNER]);
    expect(calls.proofWrites).toBe(1);
  });

  it('refuses a proof whose receipt was never uploaded, and writes nothing', async () => {
    const { submit, calls } = build({ stored: false });
    await expect(submit(PROOF)).rejects.toMatchObject({ reason: 'receipt_missing' });
    expect(calls.proofWrites).toBe(0);
  });

  it('answers proof_already_sent to the proof that lost the race', async () => {
    const { submit } = build({ won: false });
    await expect(submit(PROOF)).rejects.toMatchObject({ reason: 'proof_already_sent' });
  });
});
