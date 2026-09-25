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
] as const;
export type NotifyTemplate = (typeof NOTIFY_TEMPLATES)[number];

/** One call is one channel (F-067-o, ADR-0084 decision 2): the worker marks each on its own, so a redelivery repeats only the one that failed. */
export const NOTIFY_CHANNELS = ['inbox', 'bot'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

/** `count` (F-067-p, ADR-0084 decision 3): the worker combined this many of one template into one notice; the summary text is told, with `{{count}}`. */
export type NotifyRequest = { userId: string; channel: NotifyChannel; template: NotifyTemplate; params: Record<string, string>; count?: number };
export type NotifyResult = { sent: BotPlatform[] };

type Texts = Partial<Record<string, string>>;
type NotificationsNamespace = { payment?: Texts; subscription?: Texts; panel?: Texts; purchase?: Texts };
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
};

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
    const text = interpolate(spec.read(ns) ?? spec.fallback, params);

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
