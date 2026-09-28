import { OutboxEventType } from './routing-keys';
import { RETENTION_KIND_OF, type RetentionKind } from './retention-kinds';

/**
 * A notice's class (F-601-s, ADR-0097 part 2), strongest first. The first
 * "yes" of ADR-0097's questions is the class: the answer to what the user just
 * did (`response`), someone else may have acted on the account (`security`),
 * a loss happened or is certain (`critical`), the user must act soon
 * (`important`), anything else (`info`).
 *
 * | class | channels | mute | quiet hours |
 * |---|---|---|---|
 * | critical | inbox + one messenger | never | ignored |
 * | important | inbox + one messenger | by kind (F-601-m) | bot held |
 * | info | inbox only | by kind | — |
 *
 * `response` and `security` have no notice yet: a response is the page's own
 * answer, and a security notice's every-chat + SMS delivery is F-601-t's.
 */
export const NOTICE_CLASSES = ['response', 'security', 'critical', 'important', 'info'] as const;
export type NoticeClass = (typeof NOTICE_CLASSES)[number];

const OF_KIND: Record<RetentionKind, NoticeClass> = {
  cutoff: 'critical',
  // "An all-clear follows its alarm": it takes the stopped state's channels; its mute switch stays the kind's.
  reactivated: 'critical',
  ending: 'important',
  usage: 'important',
  connect: 'important',
};

/**
 * Each notice's class — the one table that says which channels a notice
 * takes, so no producer or consumer knows about channels. A notice is named
 * by its outbox type when that type is one notice (every retention type, so
 * 50 % and 80 % differ though they share a template), else by the template
 * its consumer picks (one event may tell two people two things). A notice
 * missing here is `critical` ({@link noticeClassOf}), never quietly dropped
 * from the bot. The names do not collide: a type is dotted, a template is not.
 */
export const NOTICE_CLASS_OF: Readonly<Record<string, NoticeClass>> = {
  ...Object.fromEntries(Object.entries(RETENTION_KIND_OF).map(([type, kind]) => [type, OF_KIND[kind!]])),
  // Half the volume used: nothing to do yet, so it is the inbox's alone.
  [OutboxEventType.GRANT_USAGE_50]: 'info',

  // The purchase, payment and panel notices (user 2026-09-28): money or a service lost is critical,
  // something the user must do or got is important.
  paymentReversed: 'critical',
  purchaseRefunded: 'critical',
  purchaseStuckPanelUnavailable: 'critical',
  purchaseStuckWriteUnconfirmed: 'critical',
  purchaseStuckStrategyNotBuilt: 'critical',
  subscriptionSuspended: 'critical',
  paymentCredited: 'important',
  purchaseDelivered: 'important',
  purchaseDelayed: 'important',
  subscriptionPaymentDue: 'important',
  panelRefused: 'important',
  panelAccepted: 'info',
};

/** The class of a notice, or of several told as one message — the strongest of them. A name missing from the table is `critical`. */
export function noticeClassOf(notice: string, ...more: readonly string[]): NoticeClass {
  const rank = (n: string) => NOTICE_CLASSES.indexOf(NOTICE_CLASS_OF[n] ?? 'critical');
  return NOTICE_CLASSES[Math.min(...[notice, ...more].map(rank))]!;
}
