import type { Logger } from '@nestjs/common';
import { BotClientRegistry, BotPlatform, escapeHtml } from '@txnet-backend/messenger';
import type { NoticeMessenger } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type { NoticeKeyboard } from './notice-buttons';

/** Who a bot notice goes to: the person, their chosen messenger (null reads as both), and `every` — a security notice's every chat. */
export type BotRecipient = { tenantId: string; userId: string; template: string; messenger: NoticeMessenger | null; every?: boolean };

/**
 * A notice on the person's bot (F-067-o, F-601-t): their verified chats, the
 * chosen platform first and the rest as a fallback — or every one when they
 * chose both or the notice is a security one. The text is escaped whole: a
 * chat message is sent in HTML parse mode, and a subject a person wrote must
 * never fail the send. Throws when chats existed and every send failed, so
 * the channel stays owed.
 */
export async function tellOnBot(deps: { prisma: PrismaService; bots: BotClientRegistry; logger: Logger }, to: BotRecipient, message: { text: string; markup?: NoticeKeyboard }): Promise<{ sent: BotPlatform[] }> {
  const links = await deps.prisma.linkedBotAccount.findMany({
    where: { userId: to.userId, contactVerifiedAt: { not: null } },
    select: { platform: true, platformUserId: true },
    orderBy: { linkedAt: 'desc' },
  });
  const choice = to.messenger ?? 'both';
  const every = to.every || choice === 'both';
  // The chosen platform first; the rest keep linked-last order for the fallback.
  const ordered = every ? links : [...links.filter((l) => l.platform === choice), ...links.filter((l) => l.platform !== choice)];
  const chatText = escapeHtml(message.text);
  let lastError: unknown = null;
  const sent: BotPlatform[] = [];
  for (const link of ordered) {
    const platform: BotPlatform = link.platform;
    const client = await deps.bots.primaryClient(to.tenantId, platform, 'identity:UserNotifier');
    if (!client) continue;
    try {
      await (message.markup ? client.sendMessage(link.platformUserId, chatText, message.markup) : client.sendMessage(link.platformUserId, chatText));
      sent.push(platform);
      if (!every) break;
    } catch (err) {
      lastError = err;
      deps.logger.warn(`${to.template} to user ${to.userId} on ${platform} failed: ${(err as Error).message}`);
    }
  }
  if (sent.length === 0 && lastError) throw lastError;
  return { sent };
}
