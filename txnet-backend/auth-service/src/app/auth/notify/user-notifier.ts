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
] as const;
export type NotifyTemplate = (typeof NOTIFY_TEMPLATES)[number];

/** One call is one channel (F-067-o, ADR-0084 decision 2): the worker marks each on its own, so a redelivery repeats only the one that failed. */
export const NOTIFY_CHANNELS = ['inbox', 'bot'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** `count` (F-067-p, ADR-0084 decision 3): the worker combined this many of one template into one notice; the summary text is told, with `{{count}}`. */
export type NotifyRequest = { userId: string; channel: NotifyChannel; template: NotifyTemplate; params: Record<string, string>; count?: number };
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
};

/**
 * Lines a notice ends with when it was given their param; one without it reads
 * whole. A delivered purchase's My services page (`servicesUrl`, F-601-h), the
 * tenant's support link (`supportUrl`, F-601-c).
 */
const TRAILING_LINES: ReadonlyArray<Text & { param: string }> = [
  { param: 'servicesUrl', read: (ns) => ns?.purchase?.servicesLine, fallback: '👉 Open it: {{servicesUrl}}' },
  { param: 'supportUrl', read: (ns) => ns?.retention?.supportLine, fallback: '🛟 Support: {{supportUrl}}' },
];

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
    const text = [body, ...TRAILING_LINES.filter((l) => params[l.param]).map((l) => interpolate(l.read(ns) ?? l.fallback, params))].join('\n\n');

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
}
