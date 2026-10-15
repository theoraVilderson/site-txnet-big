import type { Mocked } from 'vitest';
import { aBotIntegration, BotText, BotView } from '@txnet-backend/messenger';

import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import type { DepositTransfer, ManualQueueRow } from '../billing-api/transfer.types';
import { ChatContext, NavState } from '../conversation/nav.types';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { ChatFiles } from './chat-files';
import { TransferPayFlow } from './transfer-pay.flow';
import { TransferReviewFlow } from './transfer-review.flow';

/**
 * A manual transfer in the chat (F-805-b): the payer sends the proof, a person
 * judges it — both through billing's own routes, the bot deciding nothing.
 * What would break silently here:
 *  - a figure the bot computed rather than billing's, or a field it judged
 *    (a tracking code "fixed", a photo refused for its size) — billing's rules
 *    in a second place;
 *  - the receipt kept only in the conversation, lost with it (ADR-0010): it is
 *    uploaded the moment it arrives, and only its key remembered;
 *  - one refused field costing the payer every answer, the photo included;
 *  - a receipt the payer was never asked for, or a step that cannot be left;
 *  - a reviewer's one stray tap closing a paid transfer for good — confirm is
 *    one tap, reject asks once more;
 *  - a confirmation from the chat that sends a reference the reviewer never
 *    typed — billing takes the payer's own.
 */

const NOW = new Date('2026-10-15T10:00:00Z');
const PAYMENT = '0f0e0d0c-0b0a-4908-8706-050403020100';
const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const no = (reason: string, facts?: Record<string, string>) => ({ ok: false, msg: `billing: ${reason}`, error: { reason, ...(facts ? { facts } : {}) } });

const CARD: DepositTransfer = {
  kind: 'card_to_card',
  destination: { cardNumber: '6037991234567890', holderName: 'A. Rahimi', bankId: 'melli' },
  amountMinor: '12500000',
  currencyCode: 'IRR',
  decimals: 0,
  windowEndsAt: '2026-10-15T10:30:00Z',
  requiredProof: ['receiptImage', 'trackingCode', 'paidAt'],
  confirmationMode: 'manual_admin_required',
};

function access() {
  const auth = { refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'a', expiresIn: 900, refreshToken: 'r' })) } as unknown as Mocked<AuthApiClient>;
  const sessions = { get: vi.fn().mockResolvedValue({ refreshToken: 'r', signedInAt: 0 }), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
  return new ChatAccess(auth, sessions);
}

/** Every key a text reaches, nested values included — what a screen says, without its wording. */
function keysOf(text: BotText | undefined): string[] {
  if (!text) return [];
  const nested = Object.values(text.values ?? {}).flatMap((v) => (typeof v === 'object' ? keysOf(v) : []));
  return [...(text.key ? [text.key] : []), ...nested];
}
const rawsOf = (text: BotText | undefined): string[] =>
  !text ? [] : [...(text.raw !== undefined ? [text.raw] : []), ...Object.values(text.values ?? {}).flatMap((v) => (typeof v === 'object' ? rawsOf(v) : []))];
const buttons = (v: BotView) => (v.actions ?? []).flat().map((a) => a.id);

describe('paying a manual transfer (TransferPayFlow)', () => {
  function build(billing: Partial<Mocked<BillingApiClient>> = {}) {
    const photo = { fileName: 'photo.jpg', contentType: 'image/jpeg', bytes: Buffer.from([0xff, 0xd8]) };
    const files = { download: vi.fn().mockResolvedValue(photo) } as unknown as ChatFiles;
    const api = {
      uploadReceipt: vi.fn().mockResolvedValue(ok({ key: 'tenants/t1/transfers/p/receipt' })),
      submitProof: vi.fn().mockResolvedValue(ok({ paymentId: PAYMENT, proofSubmittedAt: NOW.toISOString() })),
      transfer: vi.fn(),
      ...billing,
    } as unknown as Mocked<BillingApiClient>;
    return { api, files, flow: new TransferPayFlow(api, access(), files, () => NOW) };
  }
  const asked = (field: string, data: Record<string, string> = {}): NavState => ({ flow: 'transfer', step: 'transfer.proof', data: { paymentId: PAYMENT, fields: field, ...data } });

  it("shows billing's destination and exact amount — but the bank — and asks the first proof the seller wants", () => {
    const { flow } = build();

    const shown = flow.show(PAYMENT, CARD);

    expect(shown.view.body.values).toMatchObject({ amount: { values: { amount: '12500000' } }, minutes: 30 });
    expect(rawsOf(shown.view.body)).toEqual(expect.arrayContaining(['6037991234567890', 'A. Rahimi']));
    expect(rawsOf(shown.view.body)).not.toContain('melli');
    expect(keysOf(shown.view.body)).toContain(BotKeys.transfer.ask.receiptImage);
    expect(buttons(shown.view)).toContain(`mtp:${PAYMENT}`);
    expect(shown.nextState).toEqual(asked('receiptImage,trackingCode,paidAt'));
  });

  it('spells a wallet amount in its decimals, as text', () => {
    const { flow } = build();
    const shown = flow.show(PAYMENT, { ...CARD, kind: 'crypto_wallet', destination: { asset: 'USDT', network: 'TRC20', address: 'TXyz' }, amountMinor: '12500001', currencyCode: 'USDT', decimals: 6 });
    expect(shown.view.body.values).toMatchObject({ amount: { values: { amount: '12.500001' } } });
  });

  it('uploads the receipt the moment it arrives, keeps only its key, and asks the next field', async () => {
    const { flow, api } = build();

    const after = await flow.handle({ ...ctx, file: { kind: 'photo', fileId: 'F1' } }, asked('receiptImage,trackingCode'), null);

    expect(api.uploadReceipt).toHaveBeenCalledWith(PAYMENT, expect.objectContaining({ contentType: 'image/jpeg' }), expect.anything());
    expect(after.nextState?.data).toEqual({ paymentId: PAYMENT, fields: 'trackingCode', 'p:receiptImage': 'tenants/t1/transfers/p/receipt' });
    expect(keysOf(after.view.body)).toContain(BotKeys.transfer.ask.trackingCode);
  });

  it('asks for a photo again when text arrives at the receipt step, and uploads nothing', async () => {
    const { flow, api } = build();
    const after = await flow.handle({ ...ctx, text: '123456' }, asked('receiptImage'), null);
    expect(api.uploadReceipt).not.toHaveBeenCalled();
    expect(after.view.hint).toEqual({ key: BotKeys.transfer.photoExpected });
    expect(after.nextState).toEqual(asked('receiptImage'));
  });

  it("tells billing's own refusal of the file, and asks for the photo again", async () => {
    const { flow } = build({ uploadReceipt: vi.fn().mockResolvedValue(no('receipt_rejected')) });
    const after = await flow.handle({ ...ctx, file: { kind: 'document', fileId: 'F1', mimeType: 'application/pdf' } }, asked('receiptImage'), null);
    expect(after.view.hint).toMatchObject({ key: BotKeys.transfer.refused.receipt_rejected });
    expect(after.nextState).toEqual(asked('receiptImage'));
  });

  it('hands typed answers over untouched and the paid-at button as an instant, then submits every answer by its field id', async () => {
    const { flow, api } = build();

    const typed = await flow.handle({ ...ctx, text: ' ۴۴۸۸۱۲ ' }, asked('trackingCode,paidAt', { 'p:receiptImage': 'k' }), null);
    const done = await flow.handle(ctx, typed.nextState as NavState, 'transfer:paid:10');

    expect(api.submitProof).toHaveBeenCalledWith(PAYMENT, { receiptImage: 'k', trackingCode: '۴۴۸۸۱۲', paidAt: '2026-10-15T09:50:00.000Z' }, expect.anything());
    expect(done.view.body).toEqual({ key: BotKeys.transfer.sent });
    expect(done.nextState).toBeNull();
  });

  it('asks again only the field billing refused, keeping the receipt and every other answer', async () => {
    const { flow } = build({ submitProof: vi.fn().mockResolvedValue(no('invalid_proof', { trackingCode: 'invalid' })) });

    const after = await flow.handle({ ...ctx, text: '12' }, asked('trackingCode', { 'p:receiptImage': 'k' }), null);

    expect(after.nextState?.data).toEqual({ paymentId: PAYMENT, fields: 'trackingCode', 'p:receiptImage': 'k' });
    expect(keysOf(after.view.hint)).toEqual([BotKeys.transfer.refused.invalid_proof, BotKeys.transfer.field.trackingCode, BotKeys.transfer.ask.trackingCode]);
  });

  it('ends on a refusal no field can answer, in its own sentence', async () => {
    const { flow } = build({ submitProof: vi.fn().mockResolvedValue(no('duplicate_ref')) });
    const after = await flow.handle({ ...ctx, text: '448812' }, asked('trackingCode', { 'p:receiptImage': 'k' }), null);
    expect(keysOf(after.view.body)).toContain(BotKeys.transfer.refused.duplicate_ref);
    expect(after.nextState).toBeNull();
  });

  it('offers "I have paid" when the seller asks for no proof, and sends an empty one', async () => {
    const { flow, api } = build();
    const shown = flow.show(PAYMENT, { ...CARD, requiredProof: [] });
    expect(buttons(shown.view)).toContain('transfer:done');

    await flow.handle(ctx, shown.nextState as NavState, 'transfer:done');
    expect(api.submitProof).toHaveBeenCalledWith(PAYMENT, {}, expect.anything());
  });

  it.each([
    ['a closed payment', { status: 'failed', proofSubmittedAt: null }, BotKeys.transfer.closed],
    ['a proof already sent', { status: 'pending', proofSubmittedAt: NOW.toISOString() }, BotKeys.transfer.alreadySent],
  ])('starts again from billing’s answer, and says so for %s', async (_case, status, key) => {
    const { flow } = build({ transfer: vi.fn().mockResolvedValue(ok({ ...CARD, ...status })) });
    const tapped = await flow.tap(ctx, `mtp:${PAYMENT}`);
    expect(tapped.view.body).toEqual({ key });
    expect(tapped.nextState).toBeNull();
  });

  it('starts the proof again from the pay screen’s button once a reviewer sent it back', async () => {
    const { flow, api } = build({ transfer: vi.fn().mockResolvedValue(ok({ ...CARD, status: 'pending', proofSubmittedAt: null })) });
    const tapped = await flow.tap(ctx, `mtp:${PAYMENT}`);
    expect(api.transfer).toHaveBeenCalledWith(PAYMENT, expect.anything());
    expect(tapped.nextState).toEqual(asked('receiptImage,trackingCode,paidAt'));
  });
});

describe('judging a receipt (TransferReviewFlow)', () => {
  const PROOF: NonNullable<ManualQueueRow['transfer']> = {
    destinationLabel: 'Melli card',
    expectedAmountMinor: '12500000',
    currencyCode: 'IRR',
    decimals: 0,
    proof: { receiptImage: 'k', trackingCode: '448812', paidAt: '2026-10-15T09:50:00.000Z' },
    proofSubmittedAt: '2026-10-15T09:55:00.000Z',
    canReturn: true,
  };
  const WAITING: ManualQueueRow = { id: PAYMENT, amountCredited: '1250000.00', currencyCode: 'IRT', transfer: PROOF };
  const BANK_PAYMENT: ManualQueueRow = { id: 'b-1', amountCredited: '10.00', currencyCode: 'USD', transfer: null };
  const NOT_YET: ManualQueueRow = { ...WAITING, id: 'n-1', transfer: { ...PROOF, proof: null, proofSubmittedAt: null } };
  const PNG = { fileName: 'receipt', contentType: 'image/png', bytes: Buffer.from([0x89, 0x50]) };

  function build(billing: Partial<Mocked<BillingApiClient>> = {}) {
    const api = {
      manualQueue: vi.fn().mockResolvedValue(ok([BANK_PAYMENT, NOT_YET, WAITING])),
      receipt: vi.fn().mockResolvedValue(ok(PNG)),
      confirmManual: vi.fn().mockResolvedValue(ok({ paymentId: PAYMENT, outcome: 'confirmed_manually', referenceId: '448812' })),
      rejectManual: vi.fn().mockResolvedValue(ok({ paymentId: PAYMENT, outcome: 'rejected_manually', referenceId: null })),
      ...billing,
    } as unknown as Mocked<BillingApiClient>;
    const copy = { text: (_lang: string, t: BotText) => `[${t.key}]` } as unknown as BotCopy;
    return { api, flow: new TransferReviewFlow(api, access(), copy, () => NOW) };
  }

  it('lists only the transfers whose payer sent a proof, each opening its receipt', async () => {
    const { flow } = build();
    const listed = await flow.start(ctx);
    expect(buttons(listed.view)).toEqual([`mtr:o:${PAYMENT}`, 'nav:menu']);
  });

  it('shows the receipt picture before the screen, with what was asked and sent, and the three acts', async () => {
    const { flow, api } = build();

    const opened = await flow.tap(ctx, `mtr:o:${PAYMENT}`);

    expect(api.receipt).toHaveBeenCalledWith(PAYMENT, expect.anything());
    expect(opened.picture).toEqual(PNG);
    expect(rawsOf(opened.view.body)).toEqual(expect.arrayContaining(['Melli card', '448812']));
    expect(buttons(opened.view)).toEqual([`mtr:c:${PAYMENT}`, `mtr:r:${PAYMENT}`, `mtr:x:${PAYMENT}`, 'mtr:l', 'nav:menu']);
    expect(opened.view.footer).toBeUndefined();
  });

  it('offers no send-back once it was used, and says where the picture is when it could not be fetched', async () => {
    const used = { ...WAITING, transfer: { ...PROOF, canReturn: false } };
    const { flow } = build({ manualQueue: vi.fn().mockResolvedValue(ok([used])), receipt: vi.fn().mockResolvedValue(no('receipt_missing')) });
    const opened = await flow.tap(ctx, `mtr:o:${PAYMENT}`);
    expect(buttons(opened.view)).not.toContain(`mtr:r:${PAYMENT}`);
    expect(opened.picture).toBeUndefined();
    expect(opened.view.footer).toEqual({ key: BotKeys.transfer.review.noPicture });
  });

  it('confirms in one tap, with a reason in the reviewer’s language and no reference typed', async () => {
    const { flow, api } = build();
    const done = await flow.tap(ctx, `mtr:c:${PAYMENT}`);
    expect(api.confirmManual).toHaveBeenCalledWith(PAYMENT, `[${BotKeys.transfer.review.reasonConfirm}]`, expect.anything());
    expect(done.view.body).toEqual({ key: BotKeys.transfer.review.confirmed });
  });

  it('asks once more before a reject, touching nothing; the second tap closes it', async () => {
    const { flow, api } = build();

    const asking = await flow.tap(ctx, `mtr:x:${PAYMENT}`);
    expect(api.rejectManual).not.toHaveBeenCalled();
    expect(buttons(asking.view)).toEqual([`mtr:y:${PAYMENT}`, `mtr:o:${PAYMENT}`]);

    const closed = await flow.tap(ctx, `mtr:y:${PAYMENT}`);
    expect(api.rejectManual).toHaveBeenCalledWith(PAYMENT, { reason: `[${BotKeys.transfer.review.reasonReject}]`, resubmit: false }, expect.anything());
    expect(closed.view.body).toEqual({ key: BotKeys.transfer.review.rejected });
  });

  it('sends the proof back in one tap, as billing’s resubmit', async () => {
    const { flow, api } = build({ rejectManual: vi.fn().mockResolvedValue(ok({ paymentId: PAYMENT, outcome: 'returned_for_proof', referenceId: null })) });
    const done = await flow.tap(ctx, `mtr:r:${PAYMENT}`);
    expect(api.rejectManual).toHaveBeenCalledWith(PAYMENT, { reason: `[${BotKeys.transfer.review.reasonReturn}]`, resubmit: true }, expect.anything());
    expect(done.view.body).toEqual({ key: BotKeys.transfer.review.returned });
  });

  it.each([
    ['another reviewer settled it first', no('not_open'), BotKeys.transfer.review.gone],
    ['its reference was credited elsewhere', no('duplicate_ref'), BotKeys.transfer.review.duplicate],
  ])('tells a confirm refused because %s in its own sentence', async (_case, answer, key) => {
    const { flow } = build({ confirmManual: vi.fn().mockResolvedValue(answer) });
    expect((await flow.tap(ctx, `mtr:c:${PAYMENT}`)).view.body).toEqual({ key });
  });

  it('says a receipt no longer waits when its payment left the queue', async () => {
    const { flow, api } = build({ manualQueue: vi.fn().mockResolvedValue(ok([BANK_PAYMENT])) });
    const opened = await flow.tap(ctx, `mtr:o:${PAYMENT}`);
    expect(api.receipt).not.toHaveBeenCalled();
    expect(opened.view.body).toEqual({ key: BotKeys.transfer.review.gone });
  });
});
