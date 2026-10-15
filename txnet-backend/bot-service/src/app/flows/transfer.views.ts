import { TRANSFER_REVIEW_CALLBACK_PREFIX, TRANSFER_REVIEW_LIST_CALLBACK, transferReviewCallback } from '@txnet-backend/shared-core';
import { BotAction, BotText, BotView } from '@txnet-backend/messenger';

import type { DepositTransfer, ManualQueueRow } from '../billing-api/transfer.types';
import { BotKeys } from '../locale/bot-keys';
import { minorAsDecimal, money } from '../locale/money';
import { ask, toMenu, view } from './views';

/**
 * The screens of a manual transfer in the chat (F-805-b): the payer's
 * destination and proof steps, and the reviewer's list and receipt. Pure — the
 * flows read billing and pick; every figure is billing's, every word a key.
 */

/** The proof fields answered other than by typing: billing's shared `RECEIPT_IMAGE` and `PAID_AT` ids (F-803-b). */
export const RECEIPT_FIELD = 'receiptImage';
export const PAID_AT_FIELD = 'paidAt';

/** `mtp:<paymentId>` — send this payment's proof, from its pay screen, whatever the chat's state. */
export const TRANSFER_PAY_PREFIX = 'mtp:';
export const sendProofAction = (paymentId: string) => `${TRANSFER_PAY_PREFIX}${paymentId}`;

/** `transfer:paid:<minutes>` — when the payer says they paid, as a button; spelled into an instant, never judged here. */
export const PAID_AGO_PREFIX = 'transfer:paid:';
const PAID_AGO_MINUTES = [0, 10, 30, 60] as const;
/** `transfer:done` — "I have paid", for a gateway that asks for no proof at all. */
export const PROOF_DONE_ACTION = 'transfer:done';

/** A reviewer's act on one payment (`mtr:<kind>:<id>`): confirm, return the proof, ask to reject, reject. */
export type ReviewAct = 'c' | 'r' | 'x' | 'y';
export const reviewAction = (act: ReviewAct, paymentId: string) => `${TRANSFER_REVIEW_CALLBACK_PREFIX}${act}:${paymentId}`;

/** The bank is the panel's to draw (F-803-i), its names the panel's words; the card number already says it. */
const UNSHOWN_DESTINATION_FIELDS: ReadonlySet<string> = new Set(['bankId']);

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
/** A list a chat can read: the oldest receipts first, as billing orders them. */
export const REVIEW_LIST_MAX = 10;

/** An id that arrives from billing, looked up in a generated key family — `undefined` when this build has no words for it (C-07). */
export function keyIn<T extends Record<string, string>>(family: T, id: string): T[keyof T] | undefined {
  return Object.prototype.hasOwnProperty.call(family, id) ? family[id as keyof T] : undefined;
}

/** A field's name; an id this build does not know shows as itself rather than nothing. */
export function fieldLabel(id: string): BotText {
  const key = keyIn(BotKeys.transfer.field, id);
  return key ? { key } : { raw: id };
}

/** What to send for one proof field, as the end of a sentence. */
export function proofPrompt(id: string | undefined): BotText {
  if (id === undefined) return { key: BotKeys.transfer.askDone };
  const key = keyIn(BotKeys.transfer.ask, id);
  return key ? { key } : { key: BotKeys.transfer.askOther, values: { field: fieldLabel(id) } };
}

/** `label: value` rows, one per line — folded like `moneyTotal`'s list. */
function linesOf(rows: Array<[BotText, BotText]>): BotText | null {
  const lines: BotText[] = rows.map(([label, value]) => ({ key: BotKeys.transfer.line, values: { label, value } }));
  return lines.length ? lines.reduceRight((rest, first) => ({ key: BotKeys.transfer.lines, values: { first, rest } })) : null;
}

/** When, as "n minutes ago" — a reviewer's sense of how long a payer has waited. */
export function agoText(iso: string, now: Date): BotText {
  const minutes = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / MINUTE_MS));
  if (minutes === 0) return { key: BotKeys.transfer.justNow };
  if (minutes < HOUR_MINUTES) return { key: BotKeys.transfer.ago.minutes, values: { n: minutes } };
  if (minutes < DAY_MINUTES) return { key: BotKeys.transfer.ago.hours, values: { n: Math.floor(minutes / HOUR_MINUTES) } };
  return { key: BotKeys.transfer.ago.days, values: { n: Math.floor(minutes / DAY_MINUTES) } };
}

/** The buttons a proof step carries: the paid-at choices, "I have paid" when nothing is asked, else none. */
export function stepActions(field: string | undefined): BotAction[][] {
  if (field === undefined) return [[{ id: PROOF_DONE_ACTION, label: { key: BotKeys.action.transferPaid } }]];
  if (field !== PAID_AT_FIELD) return [];
  const choices: BotAction[] = PAID_AGO_MINUTES.map((m) => ({
    id: `${PAID_AGO_PREFIX}${m}`,
    label: m === 0 ? { key: BotKeys.transfer.justNow } : { key: BotKeys.transfer.ago.minutes, values: { n: m } },
  }));
  return [choices.slice(0, 2), choices.slice(2)];
}

/**
 * Where to send what (F-803-d), and the first proof to send back. The button
 * names the payment, so it starts the proof again after the conversation
 * expired — or after a reviewer sent the receipt back (F-805-a).
 */
export function payView(paymentId: string, t: DepositTransfer, minutesLeft: number): BotView {
  const shown = Object.entries(t.destination).filter(([id]) => !UNSHOWN_DESTINATION_FIELDS.has(id));
  const destination = linesOf(shown.map(([id, value]): [BotText, BotText] => [fieldLabel(id), { raw: String(value) }]));
  const first = t.requiredProof[0];
  return ask(
    'transfer.pay',
    {
      key: BotKeys.transfer.pay,
      values: { amount: money(minorAsDecimal(t.amountMinor, t.decimals), t.currencyCode), destination: destination ?? { raw: '' }, minutes: minutesLeft, ask: proofPrompt(first) },
    },
    [...stepActions(first), [{ id: sendProofAction(paymentId), label: { key: BotKeys.action.transferSendProof } }]],
  );
}

/** The next proof field after one was taken — or, with the reason as its hint, the same one asked again. */
export function nextStepView(field: string | undefined, hint?: BotText): BotView {
  const body: BotText = { key: hint ? BotKeys.transfer.askAgain : BotKeys.transfer.next, values: { ask: proofPrompt(field) } };
  return { ...ask('transfer.proof', body, stepActions(field)), ...(hint ? { hint } : {}) };
}

/** The receipts waiting on this reviewer, one button each. */
export function reviewListView(rows: ManualQueueRow[]): BotView {
  if (rows.length === 0) return view('transfer.reviewNone', { key: BotKeys.transfer.review.none }, [[toMenu]]);
  return view('transfer.reviewList', { key: BotKeys.transfer.review.list }, [
    ...rows.slice(0, REVIEW_LIST_MAX).flatMap((r) => {
      const t = r.transfer;
      if (!t) return [];
      const amount = money(minorAsDecimal(t.expectedAmountMinor, t.decimals), t.currencyCode);
      return [[{ id: transferReviewCallback(r.id), label: { key: BotKeys.transfer.review.row, values: { amount, destination: { raw: t.destinationLabel } } } }]];
    }),
    [toMenu],
  ]);
}

/** One receipt, judged here: what was asked, where to, what the payer sent — and the three acts. */
export function reviewView(row: ManualQueueRow & { transfer: NonNullable<ManualQueueRow['transfer']> }, o: { now: Date; pictureShown: boolean }): BotView {
  const t = row.transfer;
  const proofRows = Object.entries(t.proof ?? {})
    .filter(([id]) => id !== RECEIPT_FIELD)
    .map(([id, v]): [BotText, BotText] => [fieldLabel(id), id === PAID_AT_FIELD && typeof v === 'string' ? agoText(v, o.now) : { raw: String(v) }]);
  const lines = linesOf(proofRows);
  return {
    ...view(
      'transfer.review',
      {
        key: BotKeys.transfer.review.screen,
        values: {
          expected: money(minorAsDecimal(t.expectedAmountMinor, t.decimals), t.currencyCode),
          destination: { raw: t.destinationLabel },
          credited: money(row.amountCredited, row.currencyCode),
          sentAgo: t.proofSubmittedAt ? agoText(t.proofSubmittedAt, o.now) : { raw: '' },
          proof: lines ? { key: BotKeys.transfer.review.proof, values: { lines } } : { raw: '' },
        },
      },
      [
        [{ id: reviewAction('c', row.id), label: { key: BotKeys.action.transferConfirm } }],
        ...(t.canReturn ? [[{ id: reviewAction('r', row.id), label: { key: BotKeys.action.transferReturn } }]] : []),
        [{ id: reviewAction('x', row.id), label: { key: BotKeys.action.transferReject } }],
        [{ id: TRANSFER_REVIEW_LIST_CALLBACK, label: { key: BotKeys.action.transferAll } }, toMenu],
      ],
    ),
    ...(o.pictureShown ? {} : { footer: { key: BotKeys.transfer.review.noPicture } }),
  };
}

/** Rejecting closes the payment for good, so the tap that opens the question is never the one that answers it. */
export function rejectAskView(paymentId: string): BotView {
  return view('transfer.rejectAsk', { key: BotKeys.transfer.review.rejectAsk }, [
    [{ id: reviewAction('y', paymentId), label: { key: BotKeys.action.transferRejectYes } }],
    [{ id: transferReviewCallback(paymentId), label: { key: BotKeys.action.transferBack } }],
  ]);
}

/** What a reviewer's act did, and the way on to the next receipt. */
export function reviewedView(said: BotText): BotView {
  return view('transfer.reviewed', said, [[{ id: TRANSFER_REVIEW_LIST_CALLBACK, label: { key: BotKeys.action.transferAll } }], [toMenu]]);
}
