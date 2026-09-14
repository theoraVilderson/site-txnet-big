import { Injectable, Logger } from '@nestjs/common';
import { BotClientRegistry } from '@txnet-backend/messenger';

import { LocaleService } from '../../locale/locale.service';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../tenant-context/tenant-context';

/** The named messages a service may ask to send. A template, never text: the words are this service's, in the user's language. */
export const NOTIFY_TEMPLATES = ['paymentCredited'] as const;
export type NotifyTemplate = (typeof NOTIFY_TEMPLATES)[number];

export type NotifyRequest = { userId: string; template: NotifyTemplate; params: Record<string, string> };
export type NotifyResult = { sent: Array<'telegram' | 'bale'> };

type NotificationsNamespace = { payment?: { credited?: string } };

/** The key path in `notifications` each template reads, and the English it falls back to. */
const TEMPLATE_TEXT: Record<NotifyTemplate, { read: (ns: NotificationsNamespace | undefined) => string | undefined; fallback: string }> = {
  paymentCredited: {
    read: (ns) => ns?.payment?.credited,
    fallback: '✅ Your payment was confirmed and {{amount}} was added to your wallet. Reference: {{reference}}',
  },
};

function interpolate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`{{\\s*${key}\\s*}}`, 'g'), value),
    template,
  );
}

/**
 * Message a user on their linked bot (F-067-l, ADR-0045 decision 2).
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
  ) {}

  async notify(request: NotifyRequest): Promise<NotifyResult> {
    const tenantId = TenantContext.current('user notification').id;
    const user = await this.prisma.user.findFirst({
      where: { id: request.userId },
      select: { languagePreference: true },
    });
    if (!user) return { sent: [] };

    const links = await this.prisma.linkedBotAccount.findMany({
      where: { userId: request.userId, contactVerifiedAt: { not: null } },
      select: { platform: true, platformUserId: true },
    });

    const ns = this.locale.getNamespace(user.languagePreference, 'notifications') as NotificationsNamespace | undefined;
    const spec = TEMPLATE_TEXT[request.template];
    const text = interpolate(spec.read(ns) ?? spec.fallback, request.params);

    const sent: NotifyResult['sent'] = [];
    let lastError: unknown = null;
    for (const link of links) {
      const platform = link.platform as 'telegram' | 'bale';
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
