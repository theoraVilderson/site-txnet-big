import { Injectable, Logger, Optional } from '@nestjs/common';
import { BotClientRegistry, BotPlatform } from '@txnet-backend/messenger';

import { LocaleService } from '../../locale/locale.service';
import { NotificationInboxClient } from './notification-inbox.client';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../tenant-context/tenant-context';

/** The named messages a service may ask to send. A template, never text: the words are this service's, in the user's language. */
export const NOTIFY_TEMPLATES = [
  'paymentCredited',
  'paymentReversed',
  'subscriptionPaymentDue',
  'subscriptionSuspended',
  'panelAccepted',
  'panelRefused',
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
  'serviceWalletLow',
  'servicePurgeSoon',
  'servicePurgeSoonTopUp',
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
] as const;
export type NotifyTemplate = (typeof NOTIFY_TEMPLATES)[number];

/** One call is one channel (F-067-o, ADR-0084 decision 2): the worker marks each on its own, so a redelivery repeats only the one that failed. */
export const NOTIFY_CHANNELS = ['inbox', 'bot'] as const;
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
 */
export type NotifyRequest = {
  userId: string;
  channel: NotifyChannel;
  template: NotifyTemplate;
  params: Record<string, string>;
  count?: number;
  services?: NotifyService[];
};
export type NotifyResult = { sent: BotPlatform[] };

type Texts = Partial<Record<string, string>>;
type NotificationsNamespace = { payment?: Texts; subscription?: Texts; panel?: Texts; purchase?: Texts; retention?: Texts };
type Text = { read: (ns: NotificationsNamespace | undefined) => string | undefined; fallback: string };
type Notice = Text & { inbox: Text };

/**
 * The key path in `notifications` each template reads, and the English it
 * falls back to. `inbox` is the title of its panel inbox row: every notice has
 * one, because every notice also goes to the inbox (F-067-o, ADR-0084).
 * `many` is the same notice for a combined burst, read at `<key>Many` and
 * `<key>ManyTitle` (F-067-p).
 */
const TEMPLATE_TEXT: Record<NotifyTemplate, Notice & { many: Notice }> = {
  paymentCredited: {
    read: (ns) => ns?.payment?.credited,
    fallback: '✅ Your payment was confirmed and {{amount}} was added to your wallet. Reference: {{reference}}',
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
      '↩️ Your payment of {{amount}} was reversed by the gateway and was not added to your wallet. The bank is returning it to your card; if it has not arrived within 72 hours, contact support.',
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
  // F-067-o: a connection test's verdict, told to the owner (`accepted_low_trust` is an acceptance).
  panelAccepted: {
    read: (ns) => ns?.panel?.accepted,
    fallback: '✅ Your panel {{panel}} passed its connection test and was accepted.',
    inbox: { read: (ns) => ns?.panel?.acceptedTitle, fallback: 'Panel accepted' },
    many: {
      read: (ns) => ns?.panel?.acceptedMany,
      fallback: '✅ {{count}} of your panels passed their connection test and were accepted.',
      inbox: { read: (ns) => ns?.panel?.acceptedManyTitle, fallback: '{{count}} panels accepted' },
    },
  },
  panelRefused: {
    read: (ns) => ns?.panel?.refused,
    fallback: '❌ Your panel {{panel}} was refused: its connection test showed it cannot report what the platform needs. The details are on the systems page.',
    inbox: { read: (ns) => ns?.panel?.refusedTitle, fallback: 'Panel refused' },
    many: {
      read: (ns) => ns?.panel?.refusedMany,
      fallback: '❌ {{count}} of your panels were refused by their connection test. The details are on the systems page.',
      inbox: { read: (ns) => ns?.panel?.refusedManyTitle, fallback: '{{count}} panels refused' },
    },
  },
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
  },  serviceSpeedCappedByAdmin: {
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

};

/**
 * Lines a notice ends with when it was given their param; one without it reads
 * whole. An admin's act that also brought a stopped service back
 * (`reactivated`, F-311-s — one message, not a second "active again"), a
 * delivered purchase's My services page (`servicesUrl`, F-601-h), the
 * tenant's support link (`supportUrl`, F-601-c).
 */
const TRAILING_LINES: ReadonlyArray<Text & { param: string }> = [
  { param: 'reactivated', read: (ns) => ns?.retention?.reactivatedLine, fallback: '✅ Your service is active again and reconnects within a few minutes — its link stays the same.' },
  { param: 'servicesUrl', read: (ns) => ns?.purchase?.servicesLine, fallback: '👉 Open it: {{servicesUrl}}' },
  { param: 'supportUrl', read: (ns) => ns?.retention?.supportLine, fallback: '🛟 Support: {{supportUrl}}' },
];

/** A combined notice lists at most this many services; the rest are one "and N more" line. */
const LISTED_SERVICES = 20;

/** The words of a combined notice's list of services (F-601-p). */
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
 * inbox, `bot` messages their linked chats. The worker asks once per channel.
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
  ) {}

  async notify(request: NotifyRequest): Promise<NotifyResult> {
    const tenantId = TenantContext.current('user notification').id;
    const user = await this.prisma.user.findFirst({
      where: { id: request.userId },
      select: { languagePreference: true },
    });
    if (!user) return { sent: [] };

    const ns = this.locale.getNamespace(user.languagePreference, 'notifications') as NotificationsNamespace | undefined;
    const combined = request.count !== undefined && request.count > 1;
    const spec = combined ? TEMPLATE_TEXT[request.template].many : TEMPLATE_TEXT[request.template];
    const params = combined ? { ...request.params, count: String(request.count) } : request.params;
    const body = interpolate(spec.read(ns) ?? spec.fallback, params);
    const list = combined && request.services?.length ? this.serviceList(request.services, user.languagePreference, ns) : null;
    const text = [body, ...(list ? [list] : []), ...TRAILING_LINES.filter((l) => params[l.param]).map((l) => interpolate(l.read(ns) ?? l.fallback, params))].join('\n\n');

    if (request.channel === 'inbox') {
      // Throws: the row is owed until it lands.
      if (!this.inbox) throw new Error(`${request.template} needs the notification inbox, which is not wired`);
      await this.inbox.put({ tenantId, userId: request.userId, title: interpolate(spec.inbox.read(ns) ?? spec.inbox.fallback, params), body: text });
      return { sent: [] };
    }

    const links = await this.prisma.linkedBotAccount.findMany({
      where: { userId: request.userId, contactVerifiedAt: { not: null } },
      select: { platform: true, platformUserId: true },
    });

    const sent: NotifyResult['sent'] = [];
    let lastError: unknown = null;
    for (const link of links) {
      const platform: BotPlatform = link.platform;
      const client = await this.bots.primaryClient(tenantId, platform, 'identity:UserNotifier');
      if (!client) continue;
      try {
        await client.sendMessage(link.platformUserId, text);
        if (!sent.includes(platform)) sent.push(platform);
      } catch (err) {
        lastError = err;
        this.logger.warn(`${request.template} to user ${request.userId} on ${platform} failed: ${(err as Error).message}`);
      }
    }
    if (sent.length === 0 && lastError) throw lastError;
    return { sent };
  }

  /**
   * The services a combined notice is about, one line each (F-601-p): the
   * buyer's own name for the service first (F-307-x), then the catalog name
   * in the user's language, else the platform's default one, else the sku;
   * then the buyer's config labels. Either name tells identical purchases
   * apart. Past {@link LISTED_SERVICES}, one "and N more" line.
   */
  private serviceList(services: NotifyService[], lang: string, ns: NotificationsNamespace | undefined): string {
    const say = (t: Text, vars: Record<string, string> = {}) => interpolate(t.read(ns) ?? t.fallback, vars);
    const catalogName = (key: string | null) => {
      if (!key?.startsWith('catalog.')) return undefined;
      const entry = key.slice('catalog.'.length);
      const text = this.locale.getKey(lang, 'catalog', entry) ?? this.locale.getKey(this.locale.getDefaultLanguage(), 'catalog', entry);
      return typeof text === 'string' && text !== '' ? text : undefined;
    };
    const lines = services.slice(0, LISTED_SERVICES).map((s) => {
      const catalog = catalogName(s.nameKey) ?? s.sku ?? say(SERVICE_LIST.unnamed);
      const name = s.label ? say(SERVICE_LIST.named, { label: s.label, name: catalog }) : catalog;
      return s.labels.length > 0 ? say(SERVICE_LIST.labelled, { name, labels: s.labels.join(say(SERVICE_LIST.separator)) }) : say(SERVICE_LIST.line, { name });
    });
    if (services.length > LISTED_SERVICES) lines.push(say(SERVICE_LIST.more, { more: String(services.length - LISTED_SERVICES) }));
    return lines.join('\n');
  }
}
