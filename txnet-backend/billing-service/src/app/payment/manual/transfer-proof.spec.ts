import { objectKey } from '@txnet-backend/shared-core';

import { CARD_TO_CARD } from './kinds/card-to-card';
import { CRYPTO_WALLET } from './kinds/crypto-wallet';
import { RECEIPT_POLICY, canReturnProof, checkProof, receiptPath, transferViewOf } from './transfer-proof';

/**
 * A payer's proof of a manual transfer (F-805-a, billing
 * contract.manual-transfer.md "Proof and the queue"). What breaks silently:
 *  - a receipt key the payer typed instead of the one their upload got — any
 *    file of the tenant, another payer's receipt included, shown as theirs;
 *  - the reference read from the wrong field, or under the wrong network, so a
 *    tracking code already credited passes as new;
 *  - a proof sent back twice — the window the seller set, reopened for ever;
 *  - the queue's receipt link lasting longer than the five minutes a signed
 *    private file gets, or one minted for a proof with no image.
 */

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const PAYMENT = '00000000-0000-4000-8000-0000000000c1';
const RECEIPT = objectKey(OWNER, receiptPath(PAYMENT));
const CARD = { cardNumber: '6037991234567890', holderName: 'Sara', bankId: 'melli' };
const WALLET = { asset: 'USDT', network: 'trc20', address: 'TXYZ', decimals: 6 };

describe('the receipt upload', () => {
  it('is one private image per payment, at most 5 MB, under a path the payment names', () => {
    expect(RECEIPT_POLICY).toEqual({ types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, visibility: 'private' });
    expect(receiptPath(PAYMENT)).toBe(`transfers/${PAYMENT}/receipt`);
  });
});

describe('checkProof', () => {
  const card = (input: Record<string, unknown>, required = ['receiptImage', 'trackingCode']) =>
    checkProof({ method: CARD_TO_CARD, destination: CARD, requiredProof: required, input, receiptKey: RECEIPT });

  it("accepts the seller's required fields and reads the reference the kind names, under its network", () => {
    const checked = card({ receiptImage: RECEIPT, trackingCode: ' ۱۲۳۴-۵۶۷۸ ' });
    expect(checked).toEqual({ ok: true, fields: { receiptImage: RECEIPT, trackingCode: '12345678' }, ref: { network: 'card', txRef: '12345678' } });
  });

  it("refuses a receipt key that is not this payment's upload", () => {
    const other = objectKey(OWNER, receiptPath('00000000-0000-4000-8000-0000000000c2'));
    expect(card({ receiptImage: other, trackingCode: '12345678' })).toEqual({ ok: false, refusals: [{ field: 'receiptImage', reason: 'invalid' }] });
  });

  it('names every missing required field and every field the kind does not declare', () => {
    expect(card({ amount: '5' })).toEqual({
      ok: false,
      refusals: [
        { field: 'receiptImage', reason: 'missing' },
        { field: 'trackingCode', reason: 'missing' },
        { field: 'amount', reason: 'unknown_field' },
      ],
    });
  });

  it('has no reference when the seller did not ask for one', () => {
    expect(card({ receiptImage: RECEIPT }, ['receiptImage'])).toMatchObject({ ok: true, ref: null });
  });

  it("keys a wallet's hash by its network, upper-cased as the seller's casing must not split it", () => {
    const hash = 'a'.repeat(64);
    const checked = checkProof({ method: CRYPTO_WALLET, destination: WALLET, requiredProof: ['txHash'], input: { txHash: hash }, receiptKey: RECEIPT });
    expect(checked).toMatchObject({ ok: true, ref: { network: 'TRC20', txRef: hash } });
  });
});

describe('canReturnProof', () => {
  it('sends a proof back once, and only a proof that was sent', () => {
    expect(canReturnProof({ proofSubmittedAt: new Date(), proofReturnedAt: null })).toBe(true);
    expect(canReturnProof({ proofSubmittedAt: new Date(), proofReturnedAt: new Date() })).toBe(false);
    expect(canReturnProof({ proofSubmittedAt: null, proofReturnedAt: null })).toBe(false);
  });
});

describe('transferViewOf', () => {
  const now = new Date('2026-10-15T10:00:00Z');
  const detail = {
    destination: { label: 'Melli card', setting: { kind: 'card_to_card' } },
    expectedAmountMinor: BigInt(5_000_000),
    chargeCurrency: 'IRR',
    chargeDecimals: 0,
    network: null,
    proof: { receiptImage: RECEIPT, trackingCode: '12345678' },
    proofSubmittedAt: now,
    proofReturnedAt: null,
    reviewReason: 'proof_only' as const,
  };
  const secret = 's'.repeat(32);

  it('shows the queue what to judge by, with the receipt signed for five minutes', () => {
    const view = transferViewOf(detail, secret, now);
    expect(view).toMatchObject({
      kind: 'card_to_card',
      destinationLabel: 'Melli card',
      expectedAmountMinor: '5000000',
      currencyCode: 'IRR',
      decimals: 0,
      network: null,
      proof: detail.proof,
      reviewReason: 'proof_only',
      canReturn: true,
    });
    expect(view.receiptUrl).toContain(`/private-files/${RECEIPT}?`);
    expect(view.receiptUrlExpiresAt).toEqual(new Date(now.getTime() + 5 * 60_000));
  });

  it("names a wallet's network, so the panel can link the hash to its explorer", () => {
    expect(transferViewOf({ ...detail, network: 'TRC20' }, secret, now).network).toBe('TRC20');
  });

  it('signs nothing when the proof has no image', () => {
    const view = transferViewOf({ ...detail, proof: { trackingCode: '12345678' } }, secret, now);
    expect(view).toMatchObject({ receiptUrl: null, receiptUrlExpiresAt: null });
  });
});
