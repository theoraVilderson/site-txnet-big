import {
  lotteryJoinCallback,
  SUGGESTION_OPT_OUT_PREFIX,
  supportOpenCallback,
  TRANSFER_REVIEW_LIST_CALLBACK,
  transferReviewCallback,
} from '@txnet-backend/shared-core';

import type { NotificationsNamespace } from './user-notifier';

/** A bot message's inline keyboard, as `sendMessage` takes it. */
export type NoticeKeyboard = { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };

const one = (text: string, callbackData: string): NoticeKeyboard => ({ inline_keyboard: [[{ text, callback_data: callbackData }]] });

/**
 * The one button a notice's bot message carries, or none. Each names one id,
 * never the person, and bot-service routes it from any state:
 * - an AI suggestion's "don't show this again", by action id (F-038-g4);
 * - an opt-in lottery's Join, by lottery id (F-707-q);
 * - a support reply's or resolve's Open — the thread, ready for an answer (F-309);
 * - a transfer proof's Review — the receipt, ready to confirm; a combined one
 *   (`count`) opens every receipt waiting (F-805-b).
 */
export function noticeButton(template: string, params: Record<string, string>, ns: NotificationsNamespace | undefined): NoticeKeyboard | undefined {
  if (template.startsWith('suggestion') && params.actionId) {
    return one(ns?.suggestion?.optOut ?? "🔕 Don't show this again", `${SUGGESTION_OPT_OUT_PREFIX}${params.actionId}`);
  }
  if (template === 'lotteryOpened' && params.lotteryId) return one(ns?.engagement?.lotteryJoin ?? '✅ Join', lotteryJoinCallback(params.lotteryId));
  if ((template === 'supportReplied' || template === 'supportResolved') && params.conversationId) {
    return one(ns?.support?.open ?? '💬 Open the conversation', supportOpenCallback(params.conversationId));
  }
  if (template === 'transferProofSent' && params.paymentId) {
    return one(ns?.payment?.transferReview ?? '🧾 Review the receipt', params.count ? TRANSFER_REVIEW_LIST_CALLBACK : transferReviewCallback(params.paymentId));
  }
  return undefined;
}
