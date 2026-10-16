import type { Notice } from './user-notifier';

/**
 * The notices about a manual transfer (F-805-b), told to each person of the
 * gateway's owner who may confirm it by hand. Read at `notifications.payment.*`;
 * `notice-groups.ts` joins them to the templates, and `notice-buttons.ts`
 * gives the bot message its Review button.
 */
export const TRANSFER_NOTIFY_TEMPLATES = ['transferProofSent'] as const;

type TransferTemplate = (typeof TRANSFER_NOTIFY_TEMPLATES)[number];

export const TRANSFER_TEMPLATE_TEXT: Record<TransferTemplate, Notice & { many: Notice }> = {
  // A payer sent a transfer's receipt and waits on a person; the amount is what they were asked to send.
  transferProofSent: {
    read: (ns) => ns?.payment?.transferProofSent,
    fallback: '🧾 A receipt is waiting for your review: {{amount}} {{currencyCode}} by transfer. Check that it arrived, then confirm or reject it.',
    inbox: { read: (ns) => ns?.payment?.transferProofSentTitle, fallback: 'A receipt to review' },
    many: {
      read: (ns) => ns?.payment?.transferProofSentMany,
      fallback: '🧾 {{count}} receipts are waiting for your review.',
      inbox: { read: (ns) => ns?.payment?.transferProofSentManyTitle, fallback: '{{count}} receipts to review' },
    },
  },
};
