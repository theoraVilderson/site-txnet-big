import { Injectable, Logger, Optional } from '@nestjs/common';
import { BotClientRegistry, BotPlatform } from '@txnet-backend/messenger';
import { PACKAGE_TEXT_NAMESPACE, suggestionCopyVerdict } from '@txnet-backend/shared-core';

import { LocaleService } from '../../locale/locale.service';
import { NotificationInboxClient } from './notification-inbox.client';
import { tellOnBot } from './notice-bot';
import { noticeButton } from './notice-buttons';
import { NoticeMailer } from './notice-mail';
import { withCurrencyName } from './notice-currency';
import { withReportFigures } from './analytics-notices';
import { GROUP_NOTIFY_TEMPLATES, GROUP_TEMPLATE_TEXT } from './notice-groups';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../tenant-context/tenant-context';

/** The named messages a service may ask to send. A template, never text: the words are this service's, in the user's language. */
export const NOTIFY_TEMPLATES = [
  'paymentCredited',
  'paymentReversed',
  'subscriptionPaymentDue',
  'subscriptionSuspended',
  'resellerWholesaleUnfunded',
  'resellerEmergencyEntry',
  'resellerDomainLive',
  'resellerDomainFailed',
  'resellerDomainDropped',
  'resellerQuotaNearing',
  'resellerQuotaOverageStarted',
  'resellerQuotaStopped',
  'resellerQuotaUnpaid',
  'resellerQuotaCapReached',
  'resellerQuotaDigest',
  'wheelCapNearing',
  'lotteryWon',
  'lotteryOpened',
  'lotteryOpenedAutomatic',
  ...GROUP_NOTIFY_TEMPLATES,
  'purchaseDelivered',
  'purchaseRefunded',
  'purchaseDelayed',
  'purchaseStuckPanelUnavailable',
  'purchaseStuckWriteUnconfirmed',
  'purchaseStuckStrategyNotBuilt',
  'serviceNotConnected',
  'serviceStillNotConnected',
  'serviceUsageThreshold',
  'serviceEndsSoon',
  'serviceEndsWithinADay',
  'serviceUsageAndEndsSoon',
  'serviceUsageAndEndsWithinADay',
  'serviceEnded',
  'serviceVolumeSpent',
  'serviceWalletSpent',
  'serviceCapReached',
  'serviceWalletLow',
  'servicePurgeSoon',
  'servicePurgeSoonTopUp',
  'servicePurgeSoonRaiseCap',
  'serviceReactivated',
  'serviceIdle',
  'serviceRunsOutSoon',
  'serviceRunsOutWithinADay',
  'serviceFrozenByAdmin',
  'serviceUnfrozenByAdmin',
  'serviceDaysAddedByAdmin',
  'serviceDaysRemovedByAdmin',
  'serviceTrafficAddedByAdmin',
  'serviceTrafficRemovedByAdmin',
  'serviceTrafficResetByAdmin',
  'serviceDeletedByAdmin',
  'serviceLinkRotatedByAdmin',
  'serviceLinesChanged',
  'serviceSpeedCappedByAdmin',
  'serviceSpeedUncappedByAdmin',
  'serviceDevicesLimitedByAdmin',
  'serviceDevicesUnlimitedByAdmin',
  'serviceIssuedByAdmin',
  'serviceRenewedByAdmin',
  'configRegeneratedByAdmin',
  'configDisabledByAdmin',
  'configEnabledByAdmin',
  'configRetiredByAdmin',
  'configMovedByAdmin',
  // F-038-g3: the AI engine's suggestions, labelled in their words (ADR-0109 point 11).
  'suggestionRenew',
  'suggestionResizeUp',
  'suggestionResizeDown',
  'suggestionTopUpWallet',
  'suggestionWinBack',
  'suggestionRetainOffer',
  'suggestionCheckoutHelp',
  'suggestionUsageAlert',
  // F-038-u: an invite to the tenant's wheel — its odds are the wheel's, the same for everyone.
  'suggestionWheelInvite',
  // F-038-o4: a reseller's package upgrade, told to its owner.
  'suggestionPackageUpgrade',
  // F-1525-c: a reseller's billing wallet running out at its wholesale pace, told to its owner.
  'suggestionResellerTopUp',
  // F-033-i: a support thread has something for a reader who is not looking — one per thread until read; to the user's chats too since F-309.
  'supportReplied',
  'supportResolved',
  'supportUserWrote',
  // AC-1-s: the person's own access moved — their role now, keys their role gained or lost, their seat on a team.
  'accessRoleSet',
  'accessKeysChanged',
  // GR-1-c: a group membership of theirs reached its end.
  'accessMembershipEnded',
  // F-030-a: a key given to them for a window opened or closed.
  'accessKeyWindow',
  'accessSeatRemoved',
  'accessSeatRestored',
] as const;
export type NotifyTemplate = (typeof NOTIFY_TEMPLATES)[number];

/**
 * One call is one channel (F-067-o, ADR-0084 decision 2): the worker marks each on its own, so a redelivery repeats only the one that failed.
 * `sms` (F-601-t, ADR-0097): a security notice, and a critical one no bot reached, on the tenant's line.
 * `email` (F-1006-a): only when a sender names it — a scheduled report — to the verified address, the inbox title as its subject.
 */
export const NOTIFY_CHANNELS = ['inbox', 'bot', 'sms', 'email'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/**
 * One service a combined notice names (F-601-p): the buyer's own name for it
 * (F-307-x), its catalog name key, read here in the user's language, the sku
 * when no language has it, and the buyer's labels on its configs. `null`s: a
 * service billing did not name. `label` absent: a sender from before it.
 */
export type NotifyService = { label?: string | null; nameKey: string | null; sku: string | null; labels: string[] };

/**
 * `count` (F-067-p, ADR-0084 decision 3): the worker combined this many of one template into one notice; the summary text is told, with `{{count}}`.
 * `services` (F-601-p): the services that summary is about, listed under it.
 * `every` (F-601-t): a security notice's `bot` — every verified linked chat, not the one messenger.
 */
export type NotifyRequest = {
  userId: string;
  channel: NotifyChannel;
  every?: boolean;
  template: NotifyTemplate;
  params: Record<string, string>;
  count?: number;
  services?: NotifyService[];
};
/** Who was reached: the platforms messaged, or `sms`. Empty: no one, and not an error. */
export type NotifyResult = { sent: Array<BotPlatform | 'sms' | 'email'> };

type Texts = Partial<Record<string, string>>;
/** `resellerQuotaKeys`: a registry quota key's name, by key (F-019-v8); a product's is its catalog name. */
export type NotificationsNamespace = {
  payment?: Texts;
  subscription?: Texts;
  resellerBilling?: Texts;
  resellerSupport?: Texts;
  resellerDomain?: Texts;
  resellerQuota?: Texts;
  resellerQuotaKeys?: Texts;
  panel?: Texts;
  purchase?: Texts;
  retention?: Texts;
  suggestion?: Texts;
  engagement?: Texts;
  support?: Texts;
  access?: Texts;
  analytics?: Texts;
};
type Text = { read: (ns: NotificationsNamespace | undefined) => string | undefined; fallback: string };
export type Notice = Text & { inbox: Text };

/**
 * The key path in `notifications` each template reads, and the English it
 * falls back to. `inbox` is the title of its panel inbox row: every notice has
 * one, because every notice also goes to the inbox (F-067-o, ADR-0084).
 * `many` is the same notice for a combined burst, read at `<key>Many` and
 * `<key>ManyTitle` (F-067-p).
 */
/** Two suggestions held for one quiet window and told together (F-038-g3): rare, as the budget allows one a day. */
const SUGGESTION_MANY: Notice = {
  read: (ns) => ns?.suggestion?.many,
  fallback: '💡 You have {{count}} suggestions about your services. See them in My services.',
  inbox: { read: (ns) => ns?.suggestion?.manyTitle, fallback: '{{count}} suggestions' },
};

/** Access moved more than once in one window (AC-1-s): what changed is the panel's to show, not a list. */
const ACCESS_MANY: Notice = {
  read: (ns) => ns?.access?.many,
  fallback: '🔑 Your access changed {{count}} times. The panel shows what you can do now.',
  inbox: { read: (ns) => ns?.access?.manyTitle, fallback: 'Your access changed' },
};

/** An access notice (AC-1-s) at `access.<key>` and `access.<key>Title`, combined into {@link ACCESS_MANY}. */
const accessNotice = (key: string, fallback: string, title: string): Notice & { many: Notice } => ({
  read: (ns) => ns?.access?.[key],
  fallback,
  inbox: { read: (ns) => ns?.access?.[`${key}Title`], fallback: title },
  many: ACCESS_MANY,
});

const TEMPLATE_TEXT: Record<NotifyTemplate, Notice & { many: Notice }> = {
  paymentCredited: {
    read: (ns) => ns?.payment?.credited,
    fallback: '✅ Your payment was confirmed and {{amount}} {{currency}} was added to your wallet. Reference: {{reference}}',
    inbox: { read: (ns) => ns?.payment?.creditedTitle, fallback: 'Payment confirmed' },
    many: {
      read: (ns) => ns?.payment?.creditedMany,
      fallback: '✅ {{count}} of your payments were confirmed and added to your wallet.',
      inbox: { read: (ns) => ns?.payment?.creditedManyTitle, fallback: '{{count}} payments confirmed' },
    },
  },
  // F-067-m: the gateway reversed the payment; the bank returns the money (ADR-0046 decision 5).
  paymentReversed: {
    read: (ns) => ns?.payment?.reversed,
    fallback:
      '↩️ Your payment of {{amount}} {{currency}} was reversed by the gateway and was not added to your wallet. The bank is returning it to your card; if it has not arrived within 72 hours, contact support.',
    inbox: { read: (ns) => ns?.payment?.reversedTitle, fallback: 'Payment reversed' },
    many: {
      read: (ns) => ns?.payment?.reversedMany,
      fallback: '↩️ {{count}} of your payments were reversed by the gateway and were not added to your wallet. The bank is returning them to your card.',
      inbox: { read: (ns) => ns?.payment?.reversedManyTitle, fallback: '{{count}} payments reversed' },
    },
  },
  // F-019-c: a reseller's renewal is unpaid and in grace; its owner is told how much and until when.
  subscriptionPaymentDue: {
    read: (ns) => ns?.subscription?.paymentDue,
    fallback:
      '⚠️ Your subscription renewal of {{amount}} could not be charged: your billing balance is {{balance}}. Top up before {{suspendsAt}} or your panel will be suspended.',
    inbox: { read: (ns) => ns?.subscription?.paymentDueTitle, fallback: 'Subscription payment due' },
    many: {
      read: (ns) => ns?.subscription?.paymentDueMany,
      fallback: '⚠️ {{count}} subscription renewals could not be charged. Top up your billing balance or your panel will be suspended.',
      inbox: { read: (ns) => ns?.subscription?.paymentDueManyTitle, fallback: '{{count}} subscription payments due' },
    },
  },
  subscriptionSuspended: {
    read: (ns) => ns?.subscription?.suspended,
    fallback:
      '⛔ Your panel was suspended because the subscription renewal of {{amount}} was not paid. Nothing was deleted: top up your billing balance and it is charged and reactivated at once.',
    inbox: { read: (ns) => ns?.subscription?.suspendedTitle, fallback: 'Panel suspended for non-payment' },
    many: {
      read: (ns) => ns?.subscription?.suspendedMany,
      fallback: '⛔ Your panel was suspended {{count}} times for unpaid renewals. Nothing was deleted: top up your billing balance and it is reactivated at once.',
      inbox: { read: (ns) => ns?.subscription?.suspendedManyTitle, fallback: 'Panel suspended for non-payment ({{count}})' },
    },
  },
  // F-117-d (ADR-0104 (5)): the platform's staff entered without consent, for an emergency — told at entry.
  resellerEmergencyEntry: {
    read: (ns) => ns?.resellerSupport?.emergencyEntry,
    fallback:
      "🚨 A member of the platform's staff has entered your panel for an emergency, without your consent, for one hour. Their reason and every step they take are listed under support access in your panel.",
    inbox: { read: (ns) => ns?.resellerSupport?.emergencyEntryTitle, fallback: 'Emergency access to your panel' },
    many: {
      read: (ns) => ns?.resellerSupport?.emergencyEntryMany,
      fallback: "🚨 The platform's staff entered your panel {{count}} times for emergencies, without your consent. Their reasons and every step are listed under support access in your panel.",
      inbox: { read: (ns) => ns?.resellerSupport?.emergencyEntryManyTitle, fallback: 'Emergency access to your panel ({{count}})' },
    },
  },
  // RT-1-e2: a reseller's custom domain went live (verified and its certificate issued).
  resellerDomainLive: {
    read: (ns) => ns?.resellerDomain?.live,
    fallback: '✅ Your domain {{host}} is verified and its certificate is issued. Your panel now opens on it, and your users can sign up and buy.',
    inbox: { read: (ns) => ns?.resellerDomain?.liveTitle, fallback: 'Your domain {{host}} is live' },
    many: {
      read: (ns) => ns?.resellerDomain?.liveMany,
      fallback: '✅ {{count}} of your domains are verified and live.',
      inbox: { read: (ns) => ns?.resellerDomain?.liveManyTitle, fallback: 'Your domains are live ({{count}})' },
    },
  },
  // RT-1-e2: 72 hours of checks and the records never all passed.
  resellerDomainFailed: {
    read: (ns) => ns?.resellerDomain?.failed,
    fallback: '❌ Your domain {{host}} could not be verified within 72 hours. The domains page shows what each check expected and what it found; fix the records there and ask for a check again.',
    inbox: { read: (ns) => ns?.resellerDomain?.failedTitle, fallback: 'Domain {{host}} was not verified' },
    many: {
      read: (ns) => ns?.resellerDomain?.failedMany,
      fallback: '❌ {{count}} of your domains could not be verified within 72 hours. The domains page shows what each check found.',
      inbox: { read: (ns) => ns?.resellerDomain?.failedManyTitle, fallback: 'Domains not verified ({{count}})' },
    },
  },
  // RT-1-e2: a verified domain's TXT record was missing past its grace.
  resellerDomainDropped: {
    read: (ns) => ns?.resellerDomain?.dropped,
    fallback: "⛔ The verification record of {{host}} has been missing for 72 hours, so your panel no longer opens on it. Put the TXT record back and ask for a check on the domains page.",
    inbox: { read: (ns) => ns?.resellerDomain?.droppedTitle, fallback: 'Domain {{host}} stopped working' },
    many: {
      read: (ns) => ns?.resellerDomain?.droppedMany,
      fallback: '⛔ {{count}} of your domains lost their verification record and no longer open your panel.',
      inbox: { read: (ns) => ns?.resellerDomain?.droppedManyTitle, fallback: 'Domains stopped working ({{count}})' },
    },
  },
  // F-118-w: a reseller's billing wallet no longer funds its users on platform panels — once per refusal spell.
  resellerWholesaleUnfunded: {
    read: (ns) => ns?.resellerBilling?.wholesaleUnfunded,
    fallback:
      "⛔ Your billing balance has run out, so your users whose services run on the platform's servers have stopped as their traffic ran out. Services on your own panels keep running. Top up your billing balance and they resume by themselves — their links stay the same.",
    inbox: { read: (ns) => ns?.resellerBilling?.wholesaleUnfundedTitle, fallback: 'Your users on platform servers have stopped' },
    many: {
      read: (ns) => ns?.resellerBilling?.wholesaleUnfundedMany,
      fallback: "⛔ Your billing balance has run out ({{count}} times), so your users on the platform's servers stopped as their traffic ran out. Top up your billing balance and they resume by themselves.",
      inbox: { read: (ns) => ns?.resellerBilling?.wholesaleUnfundedManyTitle, fallback: 'Your users on platform servers have stopped ({{count}})' },
    },
  },
  // F-707-e: the wheel's day has spent 80% of its cap — to each admin who can change the wheel, once a day.
  wheelCapNearing: {
    read: (ns) => ns?.engagement?.wheelCapNearing,
    fallback: '🎡 The lucky wheel has spent {{spent}} of today\'s {{cap}} {{currencyCode}} cap ({{day}}). Once the cap is reached, spins give nothing until tomorrow; a higher cap takes effect from the next day.',
    inbox: { read: (ns) => ns?.engagement?.wheelCapNearingTitle, fallback: 'Lucky wheel at 80% of today\'s cap' },
    many: {
      read: (ns) => ns?.engagement?.wheelCapNearingMany,
      fallback: '🎡 {{count}} days of the lucky wheel reached 80% of their cap. The day-by-day report is on the wheel settings page.',
      inbox: { read: (ns) => ns?.engagement?.wheelCapNearingManyTitle, fallback: 'Lucky wheel cap notices ({{count}})' },
    },
  },
  // F-707-m: a lottery winner was given its prize — to that winner, once per place.
  lotteryWon: {
    read: (ns) => ns?.engagement?.lotteryWon,
    fallback: '🎉 You won {{prize}} in "{{title}}". It has been added {{where}}. The full result, and how to check the draw yourself, is on the lottery\'s page.',
    inbox: { read: (ns) => ns?.engagement?.lotteryWonTitle, fallback: 'You won in "{{title}}"' },
    many: {
      read: (ns) => ns?.engagement?.lotteryWonMany,
      fallback: '🎉 You won {{count}} lottery prizes. They have been added to your account; each lottery\'s page shows its result.',
      inbox: { read: (ns) => ns?.engagement?.lotteryWonManyTitle, fallback: 'Lottery prizes won ({{count}})' },
    },
  },
  // F-707-q: an opt-in lottery opened to the user's group — the bot message carries Join (`lotteryJoinCallback`).
  lotteryOpened: {
    read: (ns) => ns?.engagement?.lotteryOpened,
    fallback: '🎟 A new lottery is open for you: "{{title}}". Entry is free — tap Join to take part before it closes. Its prizes and close time are in the bot\'s Lotteries and on the panel\'s Lotteries page.{{prizeNote}}',
    inbox: { read: (ns) => ns?.engagement?.lotteryOpenedTitle, fallback: 'New lottery: "{{title}}"' },
    many: {
      read: (ns) => ns?.engagement?.lotteryOpenedMany,
      fallback: '🎟 {{count}} new lotteries are open for you. Join them in the bot\'s Lotteries or on the panel\'s Lotteries page.',
      inbox: { read: (ns) => ns?.engagement?.lotteryOpenedManyTitle, fallback: 'New lotteries ({{count}})' },
    },
  },
  // F-707-q: an automatic lottery — the inbox alone, nothing to do.
  lotteryOpenedAutomatic: {
    read: (ns) => ns?.engagement?.lotteryOpenedAutomatic,
    fallback: '🎟 You are in a new lottery: "{{title}}". Every eligible member is entered when it closes — there is nothing to do. Its prizes are on the panel\'s Lotteries page.{{prizeNote}}',
    inbox: { read: (ns) => ns?.engagement?.lotteryOpenedAutomaticTitle, fallback: 'You are in "{{title}}"' },
    many: {
      read: (ns) => ns?.engagement?.lotteryOpenedAutomaticMany,
      fallback: '🎟 You are in {{count}} new lotteries; nothing to do. Their prizes are on the panel\'s Lotteries page.',
      inbox: { read: (ns) => ns?.engagement?.lotteryOpenedAutomaticManyTitle, fallback: 'New lotteries you are in ({{count}})' },
    },
  },
  // F-019-v8: 80% of a quota's included units used, once per window and period.
  resellerQuotaNearing: {
    read: (ns) => ns?.resellerQuota?.nearing,
    fallback: '📊 {{quota}}: 80% of the {{included}} included in your package this period is used.',
    inbox: { read: (ns) => ns?.resellerQuota?.nearingTitle, fallback: '{{quota}} at 80%' },
    many: {
      read: (ns) => ns?.resellerQuota?.nearingMany,
      fallback: '{{count}} notices about your package quotas. Your usage and overage are on the Limits page of your panel.',
      inbox: { read: (ns) => ns?.resellerQuota?.nearingManyTitle, fallback: '{{count}} quota notices' },
    },
  },
  // What is included is used up on an overage quota: each further unit is paid from the billing balance.
  resellerQuotaOverageStarted: {
    read: (ns) => ns?.resellerQuota?.overageStarted,
    fallback: '📈 {{quota}}: all {{included}} included this period are used. Each further unit is charged {{unitPrice}} {{currencyCode}} from your billing balance.',
    inbox: { read: (ns) => ns?.resellerQuota?.overageStartedTitle, fallback: '{{quota}}: overage started' },
    many: {
      read: (ns) => ns?.resellerQuota?.overageStartedMany,
      fallback: '{{count}} notices about your package quotas. Your usage and overage are on the Limits page of your panel.',
      inbox: { read: (ns) => ns?.resellerQuota?.overageStartedManyTitle, fallback: '{{count}} quota notices' },
    },
  },
  // What is included is used up on a stop quota: refused until the period ends, or an upgrade (F-019-v7).
  resellerQuotaStopped: {
    read: (ns) => ns?.resellerQuota?.stopped,
    fallback: '⛔ {{quota}}: all {{included}} included this period are used, so new ones are refused until the period ends. Upgrade your package to raise it now.',
    inbox: { read: (ns) => ns?.resellerQuota?.stoppedTitle, fallback: '{{quota}}: limit reached' },
    many: {
      read: (ns) => ns?.resellerQuota?.stoppedMany,
      fallback: '{{count}} notices about your package quotas. Your usage and overage are on the Limits page of your panel.',
      inbox: { read: (ns) => ns?.resellerQuota?.stoppedManyTitle, fallback: '{{count}} quota notices' },
    },
  },
  // An overage unit the billing balance could not pay: refused until a top-up.
  resellerQuotaUnpaid: {
    read: (ns) => ns?.resellerQuota?.unpaid,
    fallback: '⛔ {{quota}}: units past what your package includes cannot be paid from your billing balance, so they are refused. Top up your billing balance to resume.',
    inbox: { read: (ns) => ns?.resellerQuota?.unpaidTitle, fallback: '{{quota}}: stopped, billing balance' },
    many: {
      read: (ns) => ns?.resellerQuota?.unpaidMany,
      fallback: '{{count}} notices about your package quotas. Your usage and overage are on the Limits page of your panel.',
      inbox: { read: (ns) => ns?.resellerQuota?.unpaidManyTitle, fallback: '{{count}} quota notices' },
    },
  },
  // The reseller's own monthly overage cap is reached (ADR-0107 point 6).
  resellerQuotaCapReached: {
    read: (ns) => ns?.resellerQuota?.capReached,
    fallback: '⛔ {{quota}}: your overage spending cap for this month is reached, so units past what your package includes are refused. Raise or remove the cap to resume.',
    inbox: { read: (ns) => ns?.resellerQuota?.capReachedTitle, fallback: '{{quota}}: overage cap reached' },
    many: {
      read: (ns) => ns?.resellerQuota?.capReachedMany,
      fallback: '{{count}} notices about your package quotas. Your usage and overage are on the Limits page of your panel.',
      inbox: { read: (ns) => ns?.resellerQuota?.capReachedManyTitle, fallback: '{{count}} quota notices' },
    },
  },
  // The daily digest from 09:00 on the quota clock: yesterday's refused units and overage (F-019-v8).
  resellerQuotaDigest: {
    read: (ns) => ns?.resellerQuota?.digest,
    fallback: '🧾 Yesterday on your package quotas: {{refused}} unit(s) refused, {{overageUnits}} sold past what is included, for {{overageCost}}.',
    inbox: { read: (ns) => ns?.resellerQuota?.digestTitle, fallback: "Yesterday's quota summary" },
    many: {
      read: (ns) => ns?.resellerQuota?.digestMany,
      fallback: '{{count}} notices about your package quotas. Your usage and overage are on the Limits page of your panel.',
      inbox: { read: (ns) => ns?.resellerQuota?.digestManyTitle, fallback: '{{count}} quota notices' },
    },
  },
  ...GROUP_TEMPLATE_TEXT,
  // F-111-d: a paid Grant was delivered, or could not be and was refunded in full.
  purchaseDelivered: {
    read: (ns) => ns?.purchase?.delivered,
    fallback: '✅ Your purchase is ready to use. You will find it under My services.',
    inbox: { read: (ns) => ns?.purchase?.deliveredTitle, fallback: 'Your purchase is ready' },
    many: {
      read: (ns) => ns?.purchase?.deliveredMany,
      fallback: '✅ {{count}} of your purchases are ready to use. You will find them under My services.',
      inbox: { read: (ns) => ns?.purchase?.deliveredManyTitle, fallback: '{{count}} purchases ready' },
    },
  },
  purchaseRefunded: {
    read: (ns) => ns?.purchase?.refunded,
    fallback: '↩️ Your purchase could not be delivered, so it was cancelled and {{amount}} was returned to your wallet.',
    inbox: { read: (ns) => ns?.purchase?.refundedTitle, fallback: 'Purchase refunded' },
    many: {
      read: (ns) => ns?.purchase?.refundedMany,
      fallback: '↩️ {{count}} of your purchases could not be delivered, so they were cancelled and their full price was returned to your wallet.',
      inbox: { read: (ns) => ns?.purchase?.refundedManyTitle, fallback: '{{count}} purchases refunded' },
    },
  },
  // F-601-c: an active service with nothing used 24 h, then 72 h, after it was ready.
  // F-601-i: a paid Grant still waiting 5 minutes on — the buyer that it is being prepared, the tenant's owner why.
  purchaseDelayed: {
    read: (ns) => ns?.purchase?.delayed,
    fallback:
      '⏳ Your purchase is paid and your service is still being prepared — this is taking a little longer than usual. You will get a message the moment it is ready; if it cannot be delivered, the full price goes back to your wallet.',
    inbox: { read: (ns) => ns?.purchase?.delayedTitle, fallback: 'Your service is being prepared' },
    many: {
      read: (ns) => ns?.purchase?.delayedMany,
      fallback: '⏳ {{count}} of your purchases are paid and still being prepared. You will get a message the moment each one is ready.',
      inbox: { read: (ns) => ns?.purchase?.delayedManyTitle, fallback: '{{count}} services being prepared' },
    },
  },
  purchaseStuckPanelUnavailable: {
    read: (ns) => ns?.purchase?.stuckPanelUnavailable,
    fallback:
      '⚠️ A paid purchase has waited over 5 minutes for its service: {{panels}} panel(s) of its group cannot take a new user — not accepted or down, no inbound selected for sale, or full. Check the systems page; it is refunded if not delivered within the hour.',
    inbox: { read: (ns) => ns?.purchase?.stuckPanelUnavailableTitle, fallback: 'A purchase is waiting for a panel' },
    many: {
      read: (ns) => ns?.purchase?.stuckPanelUnavailableMany,
      fallback: '⚠️ {{count}} paid purchases have waited over 5 minutes because panels of their groups cannot take a new user. Check the systems page.',
      inbox: { read: (ns) => ns?.purchase?.stuckPanelUnavailableManyTitle, fallback: '{{count}} purchases waiting for a panel' },
    },
  },
  purchaseStuckWriteUnconfirmed: {
    read: (ns) => ns?.purchase?.stuckWriteUnconfirmed,
    fallback:
      '⚠️ A paid purchase has waited over 5 minutes for its service: its config was sent to the panels, but too few have confirmed it — a write the panel refused, or a panel not answering. Check the systems page; it is refunded if not delivered within the hour.',
    inbox: { read: (ns) => ns?.purchase?.stuckWriteUnconfirmedTitle, fallback: 'A purchase is not confirmed by its panels' },
    many: {
      read: (ns) => ns?.purchase?.stuckWriteUnconfirmedMany,
      fallback: '⚠️ {{count}} paid purchases have waited over 5 minutes because their panels have not confirmed their configs. Check the systems page.',
      inbox: { read: (ns) => ns?.purchase?.stuckWriteUnconfirmedManyTitle, fallback: '{{count}} purchases not confirmed by panels' },
    },
  },
  purchaseStuckStrategyNotBuilt: {
    read: (ns) => ns?.purchase?.stuckStrategyNotBuilt,
    fallback:
      "⚠️ A paid purchase has waited over 5 minutes for its service: its panel group is set to a strategy that cannot deliver yet. Set the group back to mirror; it is refunded if not delivered within the hour.",
    inbox: { read: (ns) => ns?.purchase?.stuckStrategyNotBuiltTitle, fallback: "A purchase's panel group cannot deliver" },
    many: {
      read: (ns) => ns?.purchase?.stuckStrategyNotBuiltMany,
      fallback: '⚠️ {{count}} paid purchases have waited over 5 minutes because their panel group is set to a strategy that cannot deliver yet. Set it back to mirror.',
      inbox: { read: (ns) => ns?.purchase?.stuckStrategyNotBuiltManyTitle, fallback: "{{count}} purchases: panel group cannot deliver" },
    },
  },
  serviceNotConnected: {
    read: (ns) => ns?.retention?.notConnected,
    fallback:
      '👋 Your service is ready but has not been used yet. To connect: open My services, copy the subscription link (or scan its QR code), add it to your VPN app — v2rayNG, Hiddify or Streisand — and connect.',
    inbox: { read: (ns) => ns?.retention?.notConnectedTitle, fallback: 'Not connected yet?' },
    many: {
      read: (ns) => ns?.retention?.notConnectedMany,
      fallback: '👋 {{count}} of your services are ready but have not been used yet. Open My services, copy each subscription link (or scan its QR code), add it to your VPN app and connect.',
      inbox: { read: (ns) => ns?.retention?.notConnectedManyTitle, fallback: '{{count}} services not connected yet' },
    },
  },
  serviceStillNotConnected: {
    read: (ns) => ns?.retention?.stillNotConnected,
    fallback:
      '🤔 Your service still has not been used, three days after it was ready. Copy the subscription link again from My services and import it into your VPN app. If it still does not connect, support will help you.',
    inbox: { read: (ns) => ns?.retention?.stillNotConnectedTitle, fallback: 'Still not connected?' },
    many: {
      read: (ns) => ns?.retention?.stillNotConnectedMany,
      fallback: '🤔 {{count}} of your services still have not been used, three days after they were ready. Copy their links again from My services; if they still do not connect, support will help you.',
      inbox: { read: (ns) => ns?.retention?.stillNotConnectedManyTitle, fallback: '{{count}} services still not connected' },
    },
  },
  // F-601-d: a prepaid service crossed 50 / 80 / 95 % of its period's volume.
  serviceUsageThreshold: {
    read: (ns) => ns?.retention?.usageThreshold,
    fallback: "📊 You have used {{percent}}% of your service's volume; {{remaining}} is left. To keep it running without a break, renew it from My services.",
    inbox: { read: (ns) => ns?.retention?.usageThresholdTitle, fallback: '{{percent}}% of your volume used' },
    many: {
      read: (ns) => ns?.retention?.usageThresholdMany,
      fallback: '📊 {{count}} of your services are running low on volume. Check what is left in My services and renew them to keep them running.',
      inbox: { read: (ns) => ns?.retention?.usageThresholdManyTitle, fallback: '{{count}} services running low on volume' },
    },
  },
  // F-601-e: 7 and 3 days before a Grant's end, with the whole days actually left; the last level has its own text.
  serviceEndsSoon: {
    read: (ns) => ns?.retention?.endsSoon,
    fallback: '⏳ Your service ends in {{days}} days. To keep it running without a break, renew it from My services.',
    inbox: { read: (ns) => ns?.retention?.endsSoonTitle, fallback: 'Your service ends in {{days}} days' },
    many: {
      read: (ns) => ns?.retention?.endsSoonMany,
      fallback: '⏳ {{count}} of your services end within a week. See when each one ends in My services and renew them to keep them running.',
      inbox: { read: (ns) => ns?.retention?.endsSoonManyTitle, fallback: '{{count}} services ending soon' },
    },
  },
  serviceEndsWithinADay: {
    read: (ns) => ns?.retention?.endsWithinADay,
    fallback: '⏰ Your service ends within a day. Renew it now from My services so it does not stop.',
    inbox: { read: (ns) => ns?.retention?.endsWithinADayTitle, fallback: 'Your service ends within a day' },
    many: {
      read: (ns) => ns?.retention?.endsWithinADayMany,
      fallback: '⏰ {{count}} of your services end within a day. Renew them now from My services so they do not stop.',
      inbox: { read: (ns) => ns?.retention?.endsWithinADayManyTitle, fallback: '{{count}} services end within a day' },
    },
  },
  // F-601-f, F-601-n: a usage and a time threshold due the same day, told as one message; the days left pick the text.
  serviceUsageAndEndsSoon: {
    read: (ns) => ns?.retention?.usageAndEndsSoon,
    fallback:
      "📊 You have used {{percent}}% of your service's volume ({{remaining}} left), and it ends in {{days}} days. To keep it running without a break, renew it from My services.",
    inbox: { read: (ns) => ns?.retention?.usageAndEndsSoonTitle, fallback: '{{percent}}% used, {{days}} days left' },
    many: {
      read: (ns) => ns?.retention?.usageAndEndsSoonMany,
      fallback: '📊 {{count}} of your services are running low on volume and ending soon. See each one in My services and renew them to keep them running.',
      inbox: { read: (ns) => ns?.retention?.usageAndEndsSoonManyTitle, fallback: '{{count}} services running low and ending soon' },
    },
  },
  serviceUsageAndEndsWithinADay: {
    read: (ns) => ns?.retention?.usageAndEndsWithinADay,
    fallback:
      "⏰ You have used {{percent}}% of your service's volume ({{remaining}} left), and it ends within a day. Renew it now from My services so it does not stop.",
    inbox: { read: (ns) => ns?.retention?.usageAndEndsWithinADayTitle, fallback: '{{percent}}% used, ends within a day' },
    many: {
      read: (ns) => ns?.retention?.usageAndEndsWithinADayMany,
      fallback: '⏰ {{count}} of your services are running low on volume and end within a day. Renew them now from My services so they do not stop.',
      inbox: { read: (ns) => ns?.retention?.usageAndEndsWithinADayManyTitle, fallback: '{{count}} services running low and ending within a day' },
    },
  },
  // F-601-b: the service stopped — cutoff notices, never muted (F-601-m). Each says what brings it back:
  // a renewal for time or a prepaid volume, a wallet top-up for a metered Grant (a metered renewal adds days alone).
  serviceEnded: {
    read: (ns) => ns?.retention?.ended,
    fallback: "⛔ Your service's time has run out and it has stopped. Renew it from My services to turn it back on — its link stays the same.",
    inbox: { read: (ns) => ns?.retention?.endedTitle, fallback: 'Your service has ended' },
    many: {
      read: (ns) => ns?.retention?.endedMany,
      fallback: '⛔ {{count}} of your services have run out of time and stopped. Renew them from My services to turn them back on — their links stay the same.',
      inbox: { read: (ns) => ns?.retention?.endedManyTitle, fallback: '{{count}} services have ended' },
    },
  },
  serviceVolumeSpent: {
    read: (ns) => ns?.retention?.volumeSpent,
    fallback: "⛔ Your service's volume is used up and it has stopped. Renew it from My services to turn it back on — its link stays the same.",
    inbox: { read: (ns) => ns?.retention?.volumeSpentTitle, fallback: "Your service's volume is used up" },
    many: {
      read: (ns) => ns?.retention?.volumeSpentMany,
      fallback: '⛔ {{count}} of your services have used up their volume and stopped. Renew them from My services to turn them back on — their links stay the same.',
      inbox: { read: (ns) => ns?.retention?.volumeSpentManyTitle, fallback: '{{count}} services out of volume' },
    },
  },
  serviceWalletSpent: {
    read: (ns) => ns?.retention?.walletSpent,
    fallback: '⛔ Your service used up what your wallet could buy and has stopped. Top up your wallet and it turns back on by itself — its link stays the same.',
    inbox: { read: (ns) => ns?.retention?.walletSpentTitle, fallback: 'Your wallet ran out' },
    many: {
      read: (ns) => ns?.retention?.walletSpentMany,
      fallback: '⛔ {{count}} of your services used up what your wallet could buy and have stopped. Top up your wallet and they turn back on by themselves.',
      inbox: { read: (ns) => ns?.retention?.walletSpentManyTitle, fallback: '{{count}} services stopped: wallet empty' },
    },
  },
  // F-118-t: the service's own spending cap stopped it, the wallet has money — raising or removing the cap brings it back.
  serviceCapReached: {
    read: (ns) => ns?.retention?.capReached,
    fallback: '⛔ Your service reached the spending cap you set for it and has stopped — your wallet still has money. Raise or remove the cap in My services and it turns back on by itself — its link stays the same.',
    inbox: { read: (ns) => ns?.retention?.capReachedTitle, fallback: 'Your service reached its spending cap' },
    many: {
      read: (ns) => ns?.retention?.capReachedMany,
      fallback: '⛔ {{count}} of your services reached the spending caps you set and have stopped — your wallet still has money. Raise or remove their caps in My services and they turn back on by themselves.',
      inbox: { read: (ns) => ns?.retention?.capReachedManyTitle, fallback: '{{count}} services stopped at their spending cap' },
    },
  },
  // F-601-g: a metered Grant's wallet buys under a GB at its rate — once per crossing; the top-up keeps it running.
  serviceWalletLow: {
    read: (ns) => ns?.retention?.walletLow,
    fallback: "💳 Your wallet now buys only about {{remaining}} more of your service's traffic. Top up your wallet so it keeps running without a break.",
    inbox: { read: (ns) => ns?.retention?.walletLowTitle, fallback: 'Your wallet is running low' },
    many: {
      read: (ns) => ns?.retention?.walletLowMany,
      fallback: '💳 Your wallet is running low for {{count}} of your services. Top up your wallet so they keep running without a break.',
      inbox: { read: (ns) => ns?.retention?.walletLowManyTitle, fallback: 'Wallet running low for {{count}} services' },
    },
  },
  // F-601-j: a suspended Grant's config is dropped from the panel within a day (purgeAfterDays) — never muted (F-601-m).
  // What keeps it: a renewal, or a top-up for a metered Grant. After the purge a revival rebuilds it (a new config).
  servicePurgeSoon: {
    read: (ns) => ns?.retention?.purgeSoon,
    fallback: '🗑️ Your stopped service will be removed from the server within a day. Renew it from My services before then to keep its config as it is — after that, a config you added by hand has to be added again.',
    inbox: { read: (ns) => ns?.retention?.purgeSoonTitle, fallback: "Your service's config is removed within a day" },
    many: {
      read: (ns) => ns?.retention?.purgeSoonMany,
      fallback: '🗑️ {{count}} of your stopped services will be removed from the server within a day. Renew them from My services before then to keep their configs as they are.',
      inbox: { read: (ns) => ns?.retention?.purgeSoonManyTitle, fallback: '{{count}} services removed within a day' },
    },
  },
  servicePurgeSoonTopUp: {
    read: (ns) => ns?.retention?.purgeSoonTopUp,
    fallback: '🗑️ Your stopped service will be removed from the server within a day. Top up your wallet before then to keep its config as it is — after that, a config you added by hand has to be added again.',
    inbox: { read: (ns) => ns?.retention?.purgeSoonTitle, fallback: "Your service's config is removed within a day" },
    many: {
      read: (ns) => ns?.retention?.purgeSoonTopUpMany,
      fallback: '🗑️ {{count}} of your stopped services will be removed from the server within a day. Top up your wallet before then to keep their configs as they are.',
      inbox: { read: (ns) => ns?.retention?.purgeSoonManyTitle, fallback: '{{count}} services removed within a day' },
    },
  },
  // F-118-t: a service its own spending cap stopped — raising or removing the cap keeps the config.
  servicePurgeSoonRaiseCap: {
    read: (ns) => ns?.retention?.purgeSoonRaiseCap,
    fallback: '🗑️ Your stopped service will be removed from the server within a day. Raise or remove its spending cap in My services before then to keep its config as it is — after that, a config you added by hand has to be added again.',
    inbox: { read: (ns) => ns?.retention?.purgeSoonTitle, fallback: "Your service's config is removed within a day" },
    many: {
      read: (ns) => ns?.retention?.purgeSoonRaiseCapMany,
      fallback: '🗑️ {{count}} of your stopped services will be removed from the server within a day. Raise or remove their spending caps in My services before then to keep their configs as they are.',
      inbox: { read: (ns) => ns?.retention?.purgeSoonManyTitle, fallback: '{{count}} services removed within a day' },
    },
  },
  // F-601-k: a stopped Grant runs again — a renewal or a top-up brought it back; the link is the same one.
  serviceReactivated: {
    read: (ns) => ns?.retention?.reactivated,
    fallback: '✅ Your service is active again. It reconnects within a few minutes — its link stays the same, so there is nothing to change in your app.',
    inbox: { read: (ns) => ns?.retention?.reactivatedTitle, fallback: 'Your service is active again' },
    many: {
      read: (ns) => ns?.retention?.reactivatedMany,
      fallback: '✅ {{count}} of your services are active again. They reconnect within a few minutes — their links stay the same.',
      inbox: { read: (ns) => ns?.retention?.reactivatedManyTitle, fallback: '{{count}} services are active again' },
    },
  },
  // F-601-l: used, then nothing for 7 days — one check-in per idle stretch.
  serviceIdle: {
    read: (ns) => ns?.retention?.idle,
    fallback:
      '🔌 Your service has not been used for a week. If it stopped connecting: open My services, copy the subscription link again and update it in your VPN app — its servers may have changed. If you simply did not need it, there is nothing to do.',
    inbox: { read: (ns) => ns?.retention?.idleTitle, fallback: 'Trouble connecting?' },
    many: {
      read: (ns) => ns?.retention?.idleMany,
      fallback: '🔌 {{count}} of your services have not been used for a week. If they stopped connecting: copy their subscription links again from My services and update them in your VPN app.',
      inbox: { read: (ns) => ns?.retention?.idleManyTitle, fallback: '{{count}} services unused for a week' },
    },
  },
  // F-602: at the last 72 h's rate, what is left runs out within N days — once per usage period.
  serviceRunsOutSoon: {
    read: (ns) => ns?.retention?.runsOutSoon,
    fallback:
      '📉 At the rate you have used it over the last few days, the {{remaining}} left on your service runs out within {{days}} days. To keep it running without a break, renew it or add volume from My services.',
    inbox: { read: (ns) => ns?.retention?.runsOutSoonTitle, fallback: 'Your volume runs out in about {{days}} days' },
    many: {
      read: (ns) => ns?.retention?.runsOutSoonMany,
      fallback: '📉 At your recent rate, {{count}} of your services run out of volume within a few days. See each one in My services and renew them to keep them running.',
      inbox: { read: (ns) => ns?.retention?.runsOutSoonManyTitle, fallback: '{{count}} services running low on volume' },
    },
  },
  serviceRunsOutWithinADay: {
    read: (ns) => ns?.retention?.runsOutWithinADay,
    fallback:
      '📉 At the rate you have used it over the last few days, the {{remaining}} left on your service runs out within a day. Renew it or add volume now from My services so it does not stop.',
    inbox: { read: (ns) => ns?.retention?.runsOutWithinADayTitle, fallback: 'Your volume runs out within a day' },
    many: {
      read: (ns) => ns?.retention?.runsOutWithinADayMany,
      fallback: '📉 At your recent rate, {{count}} of your services run out of volume within a day. Renew them now from My services so they do not stop.',
      inbox: { read: (ns) => ns?.retention?.runsOutWithinADayManyTitle, fallback: '{{count}} services run out of volume within a day' },
    },
  },
  // F-311-s: an admin's act on the service, told once per act; never the admin's reason.
  serviceFrozenByAdmin: {
    read: (ns) => ns?.retention?.adminFrozen,
    fallback: '⏸️ Your service was paused by support. Its remaining time is kept: the days it stays paused are added back when it resumes.',
    inbox: { read: (ns) => ns?.retention?.adminFrozenTitle, fallback: 'Your service was paused' },
    many: {
      read: (ns) => ns?.retention?.adminFrozenMany,
      fallback: '⏸️ {{count}} of your services were paused by support. Their remaining time is kept and added back when they resume.',
      inbox: { read: (ns) => ns?.retention?.adminFrozenManyTitle, fallback: '{{count}} services paused' },
    },
  },
  serviceUnfrozenByAdmin: {
    read: (ns) => ns?.retention?.adminUnfrozen,
    fallback: '▶️ Your service was resumed by support and reconnects within a few minutes. The days it was paused were added to its end, and its link stays the same.',
    inbox: { read: (ns) => ns?.retention?.adminUnfrozenTitle, fallback: 'Your service was resumed' },
    many: {
      read: (ns) => ns?.retention?.adminUnfrozenMany,
      fallback: '▶️ {{count}} of your services were resumed by support. The days they were paused were added to their ends, and their links stay the same.',
      inbox: { read: (ns) => ns?.retention?.adminUnfrozenManyTitle, fallback: '{{count}} services resumed' },
    },
  },
  serviceDaysAddedByAdmin: {
    read: (ns) => ns?.retention?.adminDaysAdded,
    fallback: '📅 Support added {{days}} day(s) to your service. My services shows its new end date.',
    inbox: { read: (ns) => ns?.retention?.adminDaysAddedTitle, fallback: '{{days}} day(s) added to your service' },
    many: {
      read: (ns) => ns?.retention?.adminDaysAddedMany,
      fallback: '📅 Support changed the time of {{count}} of your services. My services shows their new end dates.',
      inbox: { read: (ns) => ns?.retention?.adminDaysAddedManyTitle, fallback: 'The time of {{count}} services changed' },
    },
  },
  serviceDaysRemovedByAdmin: {
    read: (ns) => ns?.retention?.adminDaysRemoved,
    fallback: '📅 Support took {{days}} day(s) off your service. My services shows its new end date.',
    inbox: { read: (ns) => ns?.retention?.adminDaysRemovedTitle, fallback: '{{days}} day(s) taken off your service' },
    many: {
      read: (ns) => ns?.retention?.adminDaysRemovedMany,
      fallback: '📅 Support changed the time of {{count}} of your services. My services shows their new end dates.',
      inbox: { read: (ns) => ns?.retention?.adminDaysRemovedManyTitle, fallback: 'The time of {{count}} services changed' },
    },
  },
  serviceTrafficAddedByAdmin: {
    read: (ns) => ns?.retention?.adminTrafficAdded,
    fallback: '📶 Support added {{amount}} to your service\'s volume.',
    inbox: { read: (ns) => ns?.retention?.adminTrafficAddedTitle, fallback: '{{amount}} added to your service' },
    many: {
      read: (ns) => ns?.retention?.adminTrafficAddedMany,
      fallback: '📶 Support changed the volume of {{count}} of your services. My services shows what each has left.',
      inbox: { read: (ns) => ns?.retention?.adminTrafficAddedManyTitle, fallback: 'The volume of {{count}} services changed' },
    },
  },
  serviceTrafficRemovedByAdmin: {
    read: (ns) => ns?.retention?.adminTrafficRemoved,
    fallback: '📶 Support took {{amount}} off your service\'s volume. My services shows what is left.',
    inbox: { read: (ns) => ns?.retention?.adminTrafficRemovedTitle, fallback: '{{amount}} taken off your service' },
    many: {
      read: (ns) => ns?.retention?.adminTrafficRemovedMany,
      fallback: '📶 Support changed the volume of {{count}} of your services. My services shows what each has left.',
      inbox: { read: (ns) => ns?.retention?.adminTrafficRemovedManyTitle, fallback: 'The volume of {{count}} services changed' },
    },
  },
  serviceTrafficResetByAdmin: {
    read: (ns) => ns?.retention?.adminTrafficReset,
    fallback: '🔄 Support reset your service\'s usage — its full volume is yours again.',
    inbox: { read: (ns) => ns?.retention?.adminTrafficResetTitle, fallback: 'Your service\'s usage was reset' },
    many: {
      read: (ns) => ns?.retention?.adminTrafficResetMany,
      fallback: '🔄 Support reset the usage of {{count}} of your services — their full volume is yours again.',
      inbox: { read: (ns) => ns?.retention?.adminTrafficResetManyTitle, fallback: 'Usage of {{count}} services reset' },
    },
  },
  serviceDeletedByAdmin: {
    read: (ns) => ns?.retention?.adminDeleted,
    fallback: '🗑️ Your service was deleted by support and no longer connects. If you think this is a mistake, contact support.',
    inbox: { read: (ns) => ns?.retention?.adminDeletedTitle, fallback: 'Your service was deleted' },
    many: {
      read: (ns) => ns?.retention?.adminDeletedMany,
      fallback: '🗑️ {{count}} of your services were deleted by support and no longer connect. If you think this is a mistake, contact support.',
      inbox: { read: (ns) => ns?.retention?.adminDeletedManyTitle, fallback: '{{count}} services deleted' },
    },
  },
  serviceLinkRotatedByAdmin: {
    read: (ns) => ns?.retention?.adminLinkRotated,
    fallback: '🔗 Support changed your service\'s subscription link. The old link no longer works: copy the new one from My services and update it in your VPN app.',
    inbox: { read: (ns) => ns?.retention?.adminLinkRotatedTitle, fallback: 'Your service\'s link changed' },
    many: {
      read: (ns) => ns?.retention?.adminLinkRotatedMany,
      fallback: '🔗 Support changed the subscription links of {{count}} of your services. The old links no longer work: copy the new ones from My services and update them in your VPN app.',
      inbox: { read: (ns) => ns?.retention?.adminLinkRotatedManyTitle, fallback: 'Links of {{count}} services changed' },
    },
  },
  // F-027-eo: the panel's owner edited what the buyer's lines are built from; the app holds the old ones until it updates.
  serviceLinesChanged: {
    read: (ns) => ns?.retention?.linesChanged,
    fallback: '🔄 The connection settings of your service were changed on the server. Open your VPN app and update the subscription; if you added a config by hand, copy it again from My services.',
    inbox: { read: (ns) => ns?.retention?.linesChangedTitle, fallback: 'Update your subscription' },
    many: {
      read: (ns) => ns?.retention?.linesChangedMany,
      fallback: '🔄 The connection settings of {{count}} of your services were changed on the server. Open your VPN app and update their subscriptions; configs added by hand are in My services to copy again.',
      inbox: { read: (ns) => ns?.retention?.linesChangedManyTitle, fallback: 'Update {{count}} subscriptions' },
    },
  },
  serviceSpeedCappedByAdmin: {
    read: (ns) => ns?.retention?.adminSpeedCapped,
    fallback: '🐢 Support limited your service\'s speed to {{mbps}} Mbps.',
    inbox: { read: (ns) => ns?.retention?.adminSpeedCappedTitle, fallback: 'Your service\'s speed was limited to {{mbps}} Mbps' },
    many: {
      read: (ns) => ns?.retention?.adminSpeedCappedMany,
      fallback: '🐢 Support limited the speed of {{count}} of your services.',
      inbox: { read: (ns) => ns?.retention?.adminSpeedCappedManyTitle, fallback: 'Speed of {{count}} services limited' },
    },
  },
  serviceSpeedUncappedByAdmin: {
    read: (ns) => ns?.retention?.adminSpeedUncapped,
    fallback: '🚀 Support lifted the speed limit on your service.',
    inbox: { read: (ns) => ns?.retention?.adminSpeedUncappedTitle, fallback: 'Your service\'s speed limit was lifted' },
    many: {
      read: (ns) => ns?.retention?.adminSpeedUncappedMany,
      fallback: '🚀 Support lifted the speed limit on {{count}} of your services.',
      inbox: { read: (ns) => ns?.retention?.adminSpeedUncappedManyTitle, fallback: 'Speed limit lifted on {{count}} services' },
    },
  },
  serviceDevicesLimitedByAdmin: {
    read: (ns) => ns?.retention?.adminDevicesLimited,
    fallback: '📱 Support limited your service to {{limit}} device(s) at once. A device over the limit cannot connect until another disconnects.',
    inbox: { read: (ns) => ns?.retention?.adminDevicesLimitedTitle, fallback: 'Your service is limited to {{limit}} device(s)' },
    many: {
      read: (ns) => ns?.retention?.adminDevicesLimitedMany,
      fallback: '📱 Support limited how many devices can use {{count}} of your services at once.',
      inbox: { read: (ns) => ns?.retention?.adminDevicesLimitedManyTitle, fallback: 'Device limit set on {{count}} services' },
    },
  },
  serviceDevicesUnlimitedByAdmin: {
    read: (ns) => ns?.retention?.adminDevicesUnlimited,
    fallback: '📱 Support lifted the device limit on your service.',
    inbox: { read: (ns) => ns?.retention?.adminDevicesUnlimitedTitle, fallback: 'Your service\'s device limit was lifted' },
    many: {
      read: (ns) => ns?.retention?.adminDevicesUnlimitedMany,
      fallback: '📱 Support lifted the device limit on {{count}} of your services.',
      inbox: { read: (ns) => ns?.retention?.adminDevicesUnlimitedManyTitle, fallback: 'Device limit lifted on {{count}} services' },
    },
  },
  serviceIssuedByAdmin: {
    read: (ns) => ns?.retention?.adminIssued,
    fallback: '🎁 Support gave you a new service. It is in My services, and its connection is ready within a few minutes.',
    inbox: { read: (ns) => ns?.retention?.adminIssuedTitle, fallback: 'You have a new service' },
    many: {
      read: (ns) => ns?.retention?.adminIssuedMany,
      fallback: '🎁 Support gave you {{count}} new services. They are in My services, and their connections are ready within a few minutes.',
      inbox: { read: (ns) => ns?.retention?.adminIssuedManyTitle, fallback: '{{count}} new services' },
    },
  },
  serviceRenewedByAdmin: {
    read: (ns) => ns?.retention?.adminRenewed,
    fallback: '🔁 Support renewed your service. My services shows its new end date and volume.',
    inbox: { read: (ns) => ns?.retention?.adminRenewedTitle, fallback: 'Your service was renewed' },
    many: {
      read: (ns) => ns?.retention?.adminRenewedMany,
      fallback: '🔁 Support renewed {{count}} of your services. My services shows their new end dates and volume.',
      inbox: { read: (ns) => ns?.retention?.adminRenewedManyTitle, fallback: '{{count}} services renewed' },
    },
  },
  configRegeneratedByAdmin: {
    read: (ns) => ns?.retention?.adminConfigRegenerated,
    fallback: '🔧 Support rebuilt one of your service\'s configs. If you added it to your app by hand, copy it again from My services; a subscription link updates on its own.',
    inbox: { read: (ns) => ns?.retention?.adminConfigRegeneratedTitle, fallback: 'A config of your service was rebuilt' },
    many: {
      read: (ns) => ns?.retention?.adminConfigRegeneratedMany,
      fallback: '🔧 Support rebuilt {{count}} of your configs. If you added them to your app by hand, copy them again from My services; a subscription link updates on its own.',
      inbox: { read: (ns) => ns?.retention?.adminConfigRegeneratedManyTitle, fallback: '{{count}} configs rebuilt' },
    },
  },
  configDisabledByAdmin: {
    read: (ns) => ns?.retention?.adminConfigDisabled,
    fallback: '⏸️ Support turned off one of your service\'s configs; it no longer connects. Your other configs are unchanged.',
    inbox: { read: (ns) => ns?.retention?.adminConfigDisabledTitle, fallback: 'A config of your service was turned off' },
    many: {
      read: (ns) => ns?.retention?.adminConfigDisabledMany,
      fallback: '⏸️ Support turned off {{count}} of your configs; they no longer connect.',
      inbox: { read: (ns) => ns?.retention?.adminConfigDisabledManyTitle, fallback: '{{count}} configs turned off' },
    },
  },
  configEnabledByAdmin: {
    read: (ns) => ns?.retention?.adminConfigEnabled,
    fallback: '▶️ Support turned one of your service\'s configs back on; it connects again within a few minutes.',
    inbox: { read: (ns) => ns?.retention?.adminConfigEnabledTitle, fallback: 'A config of your service is back on' },
    many: {
      read: (ns) => ns?.retention?.adminConfigEnabledMany,
      fallback: '▶️ Support turned {{count}} of your configs back on; they connect again within a few minutes.',
      inbox: { read: (ns) => ns?.retention?.adminConfigEnabledManyTitle, fallback: '{{count}} configs back on' },
    },
  },
  configRetiredByAdmin: {
    read: (ns) => ns?.retention?.adminConfigRetired,
    fallback: '🗑️ Support removed one of your service\'s configs. My services shows the ones you still have.',
    inbox: { read: (ns) => ns?.retention?.adminConfigRetiredTitle, fallback: 'A config of your service was removed' },
    many: {
      read: (ns) => ns?.retention?.adminConfigRetiredMany,
      fallback: '🗑️ Support removed {{count}} of your configs. My services shows the ones you still have.',
      inbox: { read: (ns) => ns?.retention?.adminConfigRetiredManyTitle, fallback: '{{count}} configs removed' },
    },
  },
  configMovedByAdmin: {
    read: (ns) => ns?.retention?.adminConfigMoved,
    fallback: '🔀 Support moved one of your service\'s configs to another server. If you added it to your app by hand, copy it again from My services; a subscription link updates on its own.',
    inbox: { read: (ns) => ns?.retention?.adminConfigMovedTitle, fallback: 'A config of your service moved server' },
    many: {
      read: (ns) => ns?.retention?.adminConfigMovedMany,
      fallback: '🔀 Support moved {{count}} of your configs to other servers. If you added them to your app by hand, copy them again from My services; a subscription link updates on its own.',
      inbox: { read: (ns) => ns?.retention?.adminConfigMovedManyTitle, fallback: '{{count}} configs moved server' },
    },
  },
  // F-038-g3 (ADR-0109 point 11): an AI suggestion, always labelled as one. `service` and `plan` are
  // named here from billing's keys (`withServiceNames`); the price is billing's price in force.
  suggestionRenew: {
    read: (ns) => ns?.suggestion?.renew,
    fallback: '💡 Suggestion: {{service}} ends in {{days}} days. Renew it to keep it running without a break — {{price}} for the next period.',
    inbox: { read: (ns) => ns?.suggestion?.renewTitle, fallback: 'Suggestion: renew {{service}}' },
    many: SUGGESTION_MANY,
  },
  suggestionResizeUp: {
    read: (ns) => ns?.suggestion?.resize_up,
    fallback: '💡 Suggestion: {{service}} ran out before its end in your last periods. {{plan}} fits how you use it — {{price}} for the next period.',
    inbox: { read: (ns) => ns?.suggestion?.resize_upTitle, fallback: 'Suggestion: a bigger plan for {{service}}' },
    many: SUGGESTION_MANY,
  },
  suggestionResizeDown: {
    read: (ns) => ns?.suggestion?.resize_down,
    fallback: '💡 Suggestion: in your last two periods {{service}} used under half of its plan. {{plan}} would have been enough — {{price}} for the next period, less than you pay now.',
    inbox: { read: (ns) => ns?.suggestion?.resize_downTitle, fallback: 'Suggestion: a smaller plan for {{service}}' },
    many: SUGGESTION_MANY,
  },
  // F-038-k: the wallet short of the next two renewals — told instead of `renew`, one suggestion per Grant.
  suggestionTopUpWallet: {
    read: (ns) => ns?.suggestion?.top_up_wallet,
    fallback: '💡 Suggestion: {{service}} ends in {{days}} days, and your wallet holds less than its next two periods. Topping up {{amount}} covers this renewal and the next — {{price}} each.',
    inbox: { read: (ns) => ns?.suggestion?.top_up_walletTitle, fallback: 'Suggestion: top up your wallet for {{service}}' },
    many: SUGGESTION_MANY,
  },
  // F-038-n: 14 / 30 / 60 days without an active Grant — the last one's plan, at today's price.
  suggestionWinBack: {
    read: (ns) => ns?.suggestion?.win_back,
    fallback: '💡 Suggestion: {{service}} ended a while ago. If you want it back, {{plan}} is {{price}} for a period.',
    inbox: { read: (ns) => ns?.suggestion?.win_backTitle, fallback: 'Suggestion: {{service}} again' },
    many: SUGGESTION_MANY,
  },
  // F-038-f3 (ADR-0110): a renewal unlikely without a discount — the user's own single-use code from billing,
  // the discount it gives and the price after it.
  suggestionRetainOffer: {
    read: (ns) => ns?.suggestion?.retain_offer,
    fallback: '💡 Suggestion: {{service}} ends in {{days}} days. To keep it, renew with the code {{code}}: {{discount}} off, so the next period is {{price}}. The code is yours alone and works until this period ends.',
    inbox: { read: (ns) => ns?.suggestion?.retain_offerTitle, fallback: 'Suggestion: renew {{service}} for less' },
    many: SUGGESTION_MANY,
  },
  // F-038-m (ADR-0109 point 9): a payment left unfinished — another gateway billing says they can use; help, never a pitch.
  suggestionCheckoutHelp: {
    read: (ns) => ns?.suggestion?.checkout_help,
    fallback: '💡 Suggestion: your payment of {{amount}} did not go through. If that gateway gives you trouble, you can also pay with {{gateway}}.',
    inbox: { read: (ns) => ns?.suggestion?.checkout_helpTitle, fallback: 'Your payment did not go through' },
    many: SUGGESTION_MANY,
  },
  // F-1516: a service's last 24 h at three times its usual day, from its own meter — told as a fact, never a pitch.
  suggestionUsageAlert: {
    read: (ns) => ns?.suggestion?.usage_alert,
    fallback: "💡 Suggestion: {{service}} used {{used}} in the last 24 hours — about {{times}} times its usual day ({{usual}}). If that wasn't you, your link may be in use somewhere else too.",
    inbox: { read: (ns) => ns?.suggestion?.usage_alertTitle, fallback: 'Suggestion: unusual use on {{service}}' },
    many: SUGGESTION_MANY,
  },
  // F-038-u (ADR-0109 point 15): a free spin on the tenant's wheel — billing said they may spin; never a pitch to pay.
  suggestionWheelInvite: {
    read: (ns) => ns?.suggestion?.wheel_invite,
    fallback: "💡 Suggestion: you have a free spin on the lucky wheel. Spinning costs nothing, and each prize's odds are shown on the wheel — the same for everyone. You'll find it in the panel and in the bot.",
    inbox: { read: (ns) => ns?.suggestion?.wheel_inviteTitle, fallback: 'Suggestion: a free spin on the wheel' },
    many: SUGGESTION_MANY,
  },
  // F-038-o4 (ADR-0109 point 4): a reseller's quota will not last its window at this rate — the package that
  // holds it, at today's price. Told to the owner; the quota named as a quota alert names it.
  suggestionPackageUpgrade: {
    read: (ns) => ns?.suggestion?.package_upgrade,
    fallback: '💡 Suggestion: {{quota}} has used {{used}} of the {{included}} your package includes this period, and at this rate it will not last the period. The {{package}} package includes {{newIncluded}} for {{price}}; an upgrade applies at once, charged for the days left.',
    inbox: { read: (ns) => ns?.suggestion?.package_upgradeTitle, fallback: 'Suggestion: the {{package}} package for {{quota}}' },
    many: SUGGESTION_MANY,
  },
  // F-1525-c (ADR-0109 point 4, §24.3): the reseller's own money — a suggestion, never a charge.
  suggestionResellerTopUp: {
    read: (ns) => ns?.suggestion?.reseller_top_up,
    fallback: "💡 Suggestion: at your users' current pace on the platform's servers, your billing balance runs out in about {{days}} days. Topping up {{amount}} covers the next 30 days.",
    inbox: { read: (ns) => ns?.suggestion?.reseller_top_upTitle, fallback: 'Suggestion: top up your billing balance' },
    many: SUGGESTION_MANY,
  },
  // F-033-i: support-service tells one per conversation until it is read, so `many` is never asked for.
  supportReplied: {
    read: (ns) => ns?.support?.replied,
    fallback: '💬 Support answered in "{{subject}}". Open Support to read it and reply.',
    inbox: { read: (ns) => ns?.support?.repliedTitle, fallback: 'Support answered you' },
    many: {
      read: (ns) => ns?.support?.repliedMany,
      fallback: '💬 Support answered in {{count}} of your conversations. Open Support to read them.',
      inbox: { read: (ns) => ns?.support?.repliedManyTitle, fallback: 'Support answers ({{count}})' },
    },
  },
  supportResolved: {
    read: (ns) => ns?.support?.resolved,
    fallback: '✅ "{{subject}}" was marked resolved. If it is not, just reply and it opens again.',
    inbox: { read: (ns) => ns?.support?.resolvedTitle, fallback: 'Your support request was resolved' },
    many: {
      read: (ns) => ns?.support?.resolvedMany,
      fallback: '✅ {{count}} of your support conversations were marked resolved.',
      inbox: { read: (ns) => ns?.support?.resolvedManyTitle, fallback: 'Support requests resolved ({{count}})' },
    },
  },
  supportUserWrote: {
    read: (ns) => ns?.support?.userWrote,
    fallback: '💬 New message in "{{subject}}", assigned to you.',
    inbox: { read: (ns) => ns?.support?.userWroteTitle, fallback: 'New message from a user' },
    many: {
      read: (ns) => ns?.support?.userWroteMany,
      fallback: '💬 New messages in {{count}} conversations assigned to you.',
      inbox: { read: (ns) => ns?.support?.userWroteManyTitle, fallback: 'New user messages ({{count}})' },
    },
  },
  // AC-1-s: every access notice combines into the same one line — the panel already shows what is held now.
  accessRoleSet: accessNotice('roleSet', '🔑 Your role is now {{role}}. The panel shows what it lets you do.', 'Your role changed'),
  accessKeysChanged: accessNotice('keysChanged', '🔑 What your role lets you do has changed.', 'Your access changed'),
  accessMembershipEnded: accessNotice('membershipEnded', '⏳ Your membership of "{{group}}" has ended.', 'A group membership ended'),
  // F-030-a: a key given to them for a window opened or closed.
  accessKeyWindow: accessNotice('keyWindow', '⏳ Access given to you for a set time has changed.', 'Your temporary access changed'),
  accessSeatRemoved: accessNotice('seatRemoved', '🚪 You were removed from the team. Its pages in the panel are closed to you now.', 'Removed from the team'),
  accessSeatRestored: accessNotice('seatRestored', '✅ Your place on the team was restored. Its pages in the panel are open to you again.', 'Back on the team'),
};

/**
 * Lines a notice ends with when given their param; one without reads whole: a
 * stopped service back in the same message (`reactivated`, F-311-s), My services (`servicesUrl`,
 * F-601-h), support (`supportUrl`, F-601-c), who may lift a freeze (F-0401-d),
 * the keys a role edit gave and took, by their labels (AC-1-s, `withKeyLabels`).
 */
const TRAILING_LINES: ReadonlyArray<Text & { param: string }> = [
  { param: 'reactivated', read: (ns) => ns?.retention?.reactivatedLine, fallback: '✅ Your service is active again and reconnects within a few minutes — its link stays the same.' },
  { param: 'servicesUrl', read: (ns) => ns?.purchase?.servicesLine, fallback: '👉 Open it: {{servicesUrl}}' },
  { param: 'supportUrl', read: (ns) => ns?.retention?.supportLine, fallback: '🛟 Support: {{supportUrl}}' },
  { param: 'selfUnfreeze', read: (ns) => ns?.retention?.selfUnfreezeLine, fallback: '🔓 You can resume it yourself on My services.' },
  { param: 'supportUnfreeze', read: (ns) => ns?.retention?.supportUnfreezeLine, fallback: '🔒 Only support can resume it.' },
  { param: 'given', read: (ns) => ns?.access?.givenLine, fallback: '➕ Now allowed: {{given}}' },
  { param: 'taken', read: (ns) => ns?.access?.takenLine, fallback: '➖ No longer allowed: {{taken}}' },
];

/** A combined notice lists at most this many services; the rest are one "and N more" line. */
const LISTED_SERVICES = 20;

/** The words of a combined notice's list of services (F-601-p). */
/** Where a lottery prize went (F-707-y): the service GB or days were added to, else the account. */
const LOTTERY_WON_WHERE: Record<'service' | 'account', Text> = {
  service: { read: (ns) => ns?.engagement?.lotteryWonOnService, fallback: 'to your service {{service}}' },
  account: { read: (ns) => ns?.engagement?.lotteryWonOnAccount, fallback: 'to your account' },
};
/** Where an announced lottery's GB or days would go now (F-707-z), for a member with a prize service to choose. */
const LOTTERY_PRIZE: Record<'note' | 'automatic', Text> = {
  note: { read: (ns) => ns?.engagement?.lotteryPrizeNote, fallback: '\n🎁 GB or days you win go {{where}}; change it with «🎁 Prize service».' },
  automatic: { read: (ns) => ns?.engagement?.lotteryPrizeAutomatic, fallback: 'to the service that runs longest' },
};
const SERVICE_LIST = {
  line: { read: (ns) => ns?.retention?.serviceLine, fallback: '• {{name}}' },
  labelled: { read: (ns) => ns?.retention?.serviceLineLabelled, fallback: '• {{name}} — {{labels}}' },
  named: { read: (ns) => ns?.retention?.serviceNamed, fallback: '{{label}} ({{name}})' },
  separator: { read: (ns) => ns?.retention?.serviceLabelsSeparator, fallback: ', ' },
  unnamed: { read: (ns) => ns?.retention?.serviceUnnamed, fallback: 'A service' },
  more: { read: (ns) => ns?.retention?.servicesMore, fallback: '…and {{more}} more' },
} satisfies Record<string, Text>;

function interpolate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value),
    template,
  );
}

/**
 * Tell a user one notice through one channel (F-067-l, ADR-0045 decision 2;
 * F-067-o, ADR-0084 decision 2): `inbox` puts the rendered row in their panel
 * inbox, `bot` messages one of their linked chats. The worker asks once per channel.
 *
 * **The user's messenger** (F-601-u, ADR-0097 part 2): Telegram, Bale or
 * both, and unchosen is both — each verified chat once, a failed one not
 * retried through the other. A chosen one is told alone, the other only when
 * that send fails (a blocked bot, or not linked); a tenant with no bot on the
 * first platform goes to the next. A security notice asks for `every` chat.
 *
 * **SMS** (F-601-t): the rendered text, without a combined notice's list, to
 * the phone the user verified, on the line notification-service picks for the
 * tenant. No verified phone, or no line, is `{sent: []}`.
 *
 * The OTP senders' neighbour and deliberately built from the same parts: the
 * tenant's primary bot per platform (`BotClientRegistry`), and only links whose
 * contact was verified — a chat id nobody proved belongs to this user is not
 * one to tell about their money.
 *
 * **Best effort per chat, not per call.** A user with no linked chat, or a
 * tenant with no bot, is `{sent: []}` and not an error: nothing about retrying
 * would change it. A call where every send **threw** does throw, so the
 * worker's event dead-letters and stays owed.
 */
@Injectable()
export class UserNotifier {
  private readonly logger = new Logger(UserNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: BotClientRegistry,
    private readonly locale: LocaleService,
    @Optional() private readonly inbox?: NotificationInboxClient,
    @Optional() private readonly mailer?: NoticeMailer,
  ) {}

  async notify(request: NotifyRequest): Promise<NotifyResult> {
    const tenantId = TenantContext.current('user notification').id;
    const user = await this.prisma.user.findFirst({
      where: { id: request.userId },
      select: { languagePreference: true, phoneNumber: true, phoneVerifiedAt: true, noticeMessenger: true, email: true, emailVerifiedAt: true },
    });
    if (!user) return { sent: [] };

    const ns = this.locale.getNamespace(user.languagePreference, 'notifications') as NotificationsNamespace | undefined;
    const combined = request.count !== undefined && request.count > 1;
    const spec = combined ? TEMPLATE_TEXT[request.template].many : TEMPLATE_TEXT[request.template];
    const lang = user.languagePreference;
    const labelled = this.withKeyLabels(this.withServiceNames(request.template, this.withQuotaName(request.template, request.params, lang, ns), lang, ns), lang, ns);
    const named = withReportFigures(request.template, labelled, lang, ns);
    const told = withCurrencyName(named, this.locale.getNamespace(lang, 'bot'));
    const params = combined ? { ...told, count: String(request.count) } : told;
    const body = interpolate(spec.read(ns) ?? spec.fallback, params);
    const list = combined && request.services?.length ? this.serviceList(request.services, user.languagePreference, ns) : null;
    const trailing = TRAILING_LINES.filter((l) => params[l.param]).map((l) => interpolate(l.read(ns) ?? l.fallback, params));
    const text = [body, ...(list ? [list] : []), ...trailing].join('\n\n');

    // F-1507: an AI suggestion leaves with one call to action at most and no pressure, on every channel.
    // It has no action button yet (its "don't show this again" is a control), so the text alone is judged.
    if (request.template.startsWith('suggestion')) {
      const verdict = suggestionCopyVerdict({ text, ctas: 0 });
      if ('rule' in verdict) {
        this.logger.warn(`${request.template} to user ${request.userId} not told: its text breaks the copy rule (${verdict.rule})`);
        return { sent: [] };
      }
    }

    if (request.channel === 'sms') {
      if (!user.phoneVerifiedAt || !user.phoneNumber) return { sent: [] };
      if (!this.inbox) throw new Error(`${request.template} by SMS needs notification-service, which is not wired`);
      // A combined notice's list of services stays off an SMS: it is the panel's to show.
      const { sent } = await this.inbox.sms({ tenantId, userId: request.userId, to: user.phoneNumber, text: [body, ...trailing].join('\n\n') });
      return { sent: sent ? ['sms'] : [] };
    }

    if (request.channel === 'inbox') {
      // Throws: the row is owed until it lands.
      if (!this.inbox) throw new Error(`${request.template} needs the notification inbox, which is not wired`);
      await this.inbox.put({ tenantId, userId: request.userId, title: interpolate(spec.inbox.read(ns) ?? spec.inbox.fallback, params), body: text });
      return { sent: [] };
    }

    if (request.channel === 'email') {
      if (!user.emailVerifiedAt || !user.email) return { sent: [] };
      const subject = interpolate(spec.inbox.read(ns) ?? spec.inbox.fallback, params);
      if (!this.mailer) throw new Error(`${request.template} by email needs the mailer, which is not wired`);
      return { sent: (await this.mailer.send(user.email, subject, text)) ? ['email'] : [] };
    }

    const to = { tenantId, userId: request.userId, template: request.template, messenger: user.noticeMessenger, every: request.every };
    return tellOnBot({ prisma: this.prisma, bots: this.bots, logger: this.logger }, to, { text, markup: noticeButton(request.template, params, ns) });
  }

  /** A quota notice names its quota in the user's language (F-019-v8): a registry key by `resellerQuotaKeys.<key>`,
   *  a product's sales by its catalog name. A name already given is kept. */
  private withQuotaName(template: NotifyTemplate, params: Record<string, string>, lang: string, ns: NotificationsNamespace | undefined): Record<string, string> {
    // F-038-o4: a package upgrade names its quota the same way, and its new number in words when there is none.
    if (template === 'suggestionPackageUpgrade' && params.newIncluded === 'unlimited') {
      params = { ...params, newIncluded: ns?.suggestion?.unlimited ?? 'no limit' };
    }
    if (!(template.startsWith('resellerQuota') || template === 'suggestionPackageUpgrade') || params.quota) return params;
    const byKey = params.quotaKey ? ns?.resellerQuotaKeys?.[params.quotaKey] : undefined;
    const quota = byKey ?? this.catalogName(params.productNameKey ?? null, lang) ?? ns?.resellerQuota?.unnamed ?? 'A quota';
    return { ...params, quota };
  }

  /** An AI suggestion (F-038-g3), a lottery win (F-707-y: `where` it went) and an announcement to a member with a prize service to
   *  choose (F-707-z: `prizeNote`) name the service as a combined notice lists it — label, then catalog name, else sku. A suggestion's
   *  plan by its catalog name (else sku) with its size; a package (PK-1-e) by its key in the user's language, else `package` as sent. */
  private withServiceNames(template: NotifyTemplate, params: Record<string, string>, lang: string, ns: NotificationsNamespace | undefined): Record<string, string> {
    if (!template.startsWith('suggestion') && !template.startsWith('lottery')) return params;
    const say = (t: Text, vars: Record<string, string> = {}) => interpolate(t.read(ns) ?? t.fallback, vars);
    const catalog = this.catalogName(params.serviceNameKey ?? null, lang) ?? params.serviceSku ?? say(SERVICE_LIST.unnamed);
    const service = params.serviceLabel ? say(SERVICE_LIST.named, { label: params.serviceLabel, name: catalog }) : catalog;
    const onService = params.serviceLabel || params.serviceNameKey || params.serviceSku;
    if (template === 'lotteryWon') return { ...params, where: say(onService ? LOTTERY_WON_WHERE.service : LOTTERY_WON_WHERE.account, { service }) };
    if (template.startsWith('lottery')) return { ...params, prizeNote: params.prizeChoice ? say(LOTTERY_PRIZE.note, { where: say(onService ? LOTTERY_WON_WHERE.service : LOTTERY_PRIZE.automatic, { service }) }) : '' };
    const planName = this.catalogName(params.planNameKey ?? null, lang) ?? params.planSku ?? '';
    const plan = params.planSize ? say(SERVICE_LIST.named, { label: planName, name: params.planSize }) : planName;
    const packageText = params.packageNameKey?.startsWith(`${PACKAGE_TEXT_NAMESPACE}.`) ? this.locale.getKey(lang, PACKAGE_TEXT_NAMESPACE, params.packageNameKey.slice(PACKAGE_TEXT_NAMESPACE.length + 1)) : undefined;
    return { ...params, service, plan, ...(typeof packageText === 'string' && packageText !== '' ? { package: packageText } : {}) };
  }

  /** The keys an access notice names, by the labels the role editor shows (AC-1-f's `permissions` namespace) in the user's
   *  language, else the default one, else the key itself — never an empty name (AC-1-s). */
  private withKeyLabels(params: Record<string, string>, lang: string, ns: NotificationsNamespace | undefined): Record<string, string> {
    if (!params.given && !params.taken) return params;
    const label = (key: string) => {
      const path = `keys.${key}.label`;
      const text = this.locale.getKey(lang, 'permissions', path) ?? this.locale.getKey(this.locale.getDefaultLanguage(), 'permissions', path);
      return typeof text === 'string' && text !== '' ? text : key;
    };
    const separator = ns?.access?.keySeparator ?? ', ';
    const named = (keys: string | undefined) => (keys ? keys.split(',').filter(Boolean).map(label).join(separator) : undefined);
    const given = named(params.given);
    const taken = named(params.taken);
    return { ...params, ...(given ? { given } : {}), ...(taken ? { taken } : {}) };
  }

  /** A `catalog.*` key in the user's language, or the default one; undefined when neither has it. */
  private catalogName(key: string | null, lang: string): string | undefined {
    if (!key?.startsWith('catalog.')) return undefined;
    const entry = key.slice('catalog.'.length);
    const text = this.locale.getKey(lang, 'catalog', entry) ?? this.locale.getKey(this.locale.getDefaultLanguage(), 'catalog', entry);
    return typeof text === 'string' && text !== '' ? text : undefined;
  }

  /** The services a combined notice is about, one line each (F-601-p): the buyer's own name (F-307-x), then the catalog name in their
   *  language, else the default one, else the sku; then their config labels. Past {@link LISTED_SERVICES}, one "and N more" line. */
  private serviceList(services: NotifyService[], lang: string, ns: NotificationsNamespace | undefined): string {
    const say = (t: Text, vars: Record<string, string> = {}) => interpolate(t.read(ns) ?? t.fallback, vars);
    const catalogName = (key: string | null) => this.catalogName(key, lang);
    const lines = services.slice(0, LISTED_SERVICES).map((s) => {
      const catalog = catalogName(s.nameKey) ?? s.sku ?? say(SERVICE_LIST.unnamed);
      const name = s.label ? say(SERVICE_LIST.named, { label: s.label, name: catalog }) : catalog;
      return s.labels.length > 0 ? say(SERVICE_LIST.labelled, { name, labels: s.labels.join(say(SERVICE_LIST.separator)) }) : say(SERVICE_LIST.line, { name });
    });
    if (services.length > LISTED_SERVICES) lines.push(say(SERVICE_LIST.more, { more: String(services.length - LISTED_SERVICES) }));
    return lines.join('\n');
  }
}
