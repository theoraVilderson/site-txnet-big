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
 * | security | inbox + every linked chat + SMS | never | ignored |
 * | critical | inbox + one messenger; SMS when no bot reached (F-601-t) | never | ignored |
 * | important | inbox + one messenger | by kind (F-601-m) | bot held |
 * | suggestion | inbox + one messenger, labelled (ADR-0109 point 11) | its own kind | bot held |
 * | info | inbox only | by kind | — |
 *
 * `response` and `security` have no notice yet: a response is the page's own
 * answer; a security notice's delivery is built (F-601-t) and waits for one.
 */
export const NOTICE_CLASSES = ['response', 'security', 'critical', 'important', 'suggestion', 'info'] as const;
export type NoticeClass = (typeof NOTICE_CLASSES)[number];

/**
 * The AI engine's suggestion (F-038-g1): one notice, every action type —
 * claimed on the retention ledger once per action (`period` = the action id).
 * Dotted like a type, though no outbox event carries it.
 */
export const SUGGESTION_NOTICE = 'ai.suggestion';

/**
 * The bot button under a suggestion, "don't show this again" (F-038-g4):
 * its callback data is this prefix and the action id — what auth-service
 * sends and bot-service routes. The id names an action, never a person.
 */
export const SUGGESTION_OPT_OUT_PREFIX = 'aio:';

/**
 * A lottery's bot buttons (F-707-p): `lot:<o|j|l|r>:<lottery id>` — open,
 * join, leave, result. The announcement (F-707-q) carries the join one, which
 * auth-service sends and bot-service routes from any state. 42 bytes, under
 * the 64-byte callback cap.
 */
export const LOTTERY_CALLBACK_PREFIX = 'lot:';
export const lotteryJoinCallback = (lotteryId: string) => `${LOTTERY_CALLBACK_PREFIX}j:${lotteryId}`;

/**
 * A support thread's bot buttons (F-309): `sup:<kind>:…`. A reply or resolve
 * notice carries the open one, which auth-service sends and bot-service routes
 * from any state — the tap lands in that thread, ready for a reply. 42 bytes.
 */
export const SUPPORT_CALLBACK_PREFIX = 'sup:';
export const supportOpenCallback = (conversationId: string) => `${SUPPORT_CALLBACK_PREFIX}o:${conversationId}`;

const OF_KIND: Record<RetentionKind, NoticeClass> = {
  cutoff: 'critical',
  // "An all-clear follows its alarm": it takes the stopped state's channels; its mute switch stays the kind's.
  reactivated: 'critical',
  ending: 'important',
  usage: 'important',
  connect: 'important',
  suggestion: 'suggestion',
  // F-707-q: an opt-in lottery asks the user to join before it closes.
  lottery: 'important',
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
  resellerWholesaleUnfunded: 'critical',
  // F-117-d: someone of the platform is among the reseller's people without its consent, now.
  resellerEmergencyEntry: 'critical',
  // F-019-v8: a reseller stopped selling past a quota is losing sales now; its 80%, overage and digest are its to plan on.
  resellerQuotaStopped: 'critical',
  resellerQuotaUnpaid: 'critical',
  resellerQuotaCapReached: 'critical',
  resellerQuotaNearing: 'important',
  resellerQuotaOverageStarted: 'important',
  resellerQuotaDigest: 'important',
  // F-707-e: the wheel's day is nearly spent; the admin may raise the cap tomorrow, nothing is lost today.
  wheelCapNearing: 'important',
  // F-707-m: a prize given — the user got something, nothing to do.
  lotteryWon: 'important',
  // F-707-q: an opt-in lottery opened to the user's group — join before it closes; an automatic one asks nothing, so the inbox's alone.
  lotteryOpened: 'important',
  lotteryOpenedAutomatic: 'info',
  paymentCredited: 'important',
  purchaseDelivered: 'important',
  // F-027-eo: a panel-side edit replaced the buyer's lines — their app needs an update before it connects again.
  serviceLinesChanged: 'important',
  purchaseDelayed: 'important',
  subscriptionPaymentDue: 'important',
  panelRefused: 'important',
  panelAccepted: 'info',
  // F-027-el: a panel went down, with what to fix — the owner must act soon; its recovery is news.
  panelDownDns: 'important',
  panelDownPort: 'important',
  panelDownUnreachable: 'important',
  panelDownTls: 'important',
  panelDownPath: 'important',
  panelDownServer: 'important',
  panelLoginRefused: 'important',
  panelRefusingUs: 'important',
  panelRecovered: 'info',
  [SUGGESTION_NOTICE]: 'suggestion',
};

/** The class of a notice, or of several told as one message — the strongest of them. A name missing from the table is `critical`. */
export function noticeClassOf(notice: string, ...more: readonly string[]): NoticeClass {
  const rank = (n: string) => NOTICE_CLASSES.indexOf(NOTICE_CLASS_OF[n] ?? 'critical');
  return NOTICE_CLASSES[Math.min(...[notice, ...more].map(rank))]!;
}
