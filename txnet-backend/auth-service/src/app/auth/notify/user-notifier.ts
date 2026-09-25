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
] as const;
export type NotifyTemplate = (typeof NOTIFY_TEMPLATES)[number];

/** One call is one channel (F-067-o, ADR-0084 decision 2): the worker marks each on its own, so a redelivery repeats only the one that failed. */
export const NOTIFY_CHANNELS = ['inbox', 'bot'] as const;
export type NotifyChannel = (typeof NOTIFY_CHANNELS)[number];

export type NotifyRequest = { userId: string; channel: NotifyChannel; template: NotifyTemplate; params: Record<string, string> };
export type NotifyResult = { sent: BotPlatform[] };

type NotificationsNamespace = {
  payment?: { creditedTitle?: string; credited?: string; reversedTitle?: string; reversed?: string };
  subscription?: { paymentDueTitle?: string; paymentDue?: string; suspendedTitle?: string; suspended?: string };
  panel?: { acceptedTitle?: string; accepted?: string; refusedTitle?: string; refused?: string };
};
type Text = { read: (ns: NotificationsNamespace | undefined) => string | undefined; fallback: string };

/**
 * The key path in `notifications` each template reads, and the English it
 * falls back to. `inbox` is the title of its panel inbox row: every notice has
 * one, because every notice also goes to the inbox (F-067-o, ADR-0084).
 */
const TEMPLATE_TEXT: Record<NotifyTemplate, Text & { inbox: Text }> = {
  paymentCredited: {
    read: (ns) => ns?.payment?.credited,
    fallback: '✅ Your payment was confirmed and {{amount}} was added to your wallet. Reference: {{reference}}',
    inbox: { read: (ns) => ns?.payment?.creditedTitle, fallback: 'Payment confirmed' },
  },
  // F-067-m: the gateway reversed the payment; the bank returns the money (ADR-0046 decision 5).
  paymentReversed: {
    read: (ns) => ns?.payment?.reversed,
    fallback:
      '↩️ Your payment of {{amount}} was reversed by the gateway and was not added to your wallet. The bank is returning it to your card; if it has not arrived within 72 hours, contact support.',
    inbox: { read: (ns) => ns?.payment?.reversedTitle, fallback: 'Payment reversed' },
  },
  // F-019-c: a reseller's renewal is unpaid and in grace; its owner is told how much and until when.
  subscriptionPaymentDue: {
    read: (ns) => ns?.subscription?.paymentDue,
    fallback:
      '⚠️ Your subscription renewal of {{amount}} could not be charged: your billing balance is {{balance}}. Top up before {{suspendsAt}} or your panel will be suspended.',
    inbox: { read: (ns) => ns?.subscription?.paymentDueTitle, fallback: 'Subscription payment due' },
  },
  subscriptionSuspended: {
    read: (ns) => ns?.subscription?.suspended,
    fallback:
      '⛔ Your panel was suspended because the subscription renewal of {{amount}} was not paid. Nothing was deleted: top up your billing balance and it is charged and reactivated at once.',
    inbox: { read: (ns) => ns?.subscription?.suspendedTitle, fallback: 'Panel suspended for non-payment' },
  },
  // F-067-o: a connection test's verdict, told to the owner (`accepted_low_trust` is an acceptance).
  panelAccepted: {
    read: (ns) => ns?.panel?.accepted,
    fallback: '✅ Your panel {{panel}} passed its connection test and was accepted.',
    inbox: { read: (ns) => ns?.panel?.acceptedTitle, fallback: 'Panel accepted' },
  },
  panelRefused: {
    read: (ns) => ns?.panel?.refused,
    fallback: '❌ Your panel {{panel}} was refused: its connection test showed it cannot report what the platform needs. The details are on the systems page.',
    inbox: { read: (ns) => ns?.panel?.refusedTitle, fallback: 'Panel refused' },
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
    const spec = TEMPLATE_TEXT[request.template];
    const text = interpolate(spec.read(ns) ?? spec.fallback, request.params);

    if (request.channel === 'inbox') {
      // Throws: the row is owed until it lands.
      if (!this.inbox) throw new Error(`${request.template} needs the notification inbox, which is not wired`);
      await this.inbox.put({ tenantId, userId: request.userId, title: interpolate(spec.inbox.read(ns) ?? spec.inbox.fallback, request.params), body: text });
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
