import { Injectable } from '@nestjs/common';
import { NoticeMessenger, Prisma, SocialPlatform } from '@prisma/client';
import { ok } from '@txnet-backend/shared-core';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthClaims } from '../token.service';

/**
 * `messenger`: what `UserNotifier` acts on — the saved one, else `both`.
 * `chosen`: whether the user picked it, so a later default can tell the two apart.
 * `linked`: the platforms with a verified chat, for the panel to say which one is not linked yet.
 */
export type MeMessenger = { messenger: NoticeMessenger; chosen: boolean; linked: SocialPlatform[] };

/** Only a chat whose contact was proved, as `UserNotifier` counts them. */
const VERIFIED: Prisma.LinkedBotAccountWhereInput = { contactVerifiedAt: { not: null } };

const SELECT = {
  noticeMessenger: true,
  linkedBotAccounts: { where: VERIFIED, select: { platform: true }, orderBy: { linkedAt: 'desc' } },
} satisfies Prisma.UserSelect;

/**
 * Which messenger the caller's notices take (F-601-u, ADR-0097 part 2):
 * Telegram, Bale or both; unchosen is both. Only the caller's own row.
 *
 * A messenger not linked yet may be chosen: the notifier then tells the
 * other one, and linking it later needs no second visit here.
 */
@Injectable()
export class MeMessengerService {
  constructor(private readonly prisma: PrismaService) {}

  async read(claims: AuthClaims) {
    const user = await this.prisma.user.findUnique({ where: { id: claims.sub }, select: SELECT });
    return ok(answer(user), 'auth.messenger');
  }

  async save(claims: AuthClaims, messenger: NoticeMessenger) {
    const user = await this.prisma.user.update({ where: { id: claims.sub }, data: { noticeMessenger: messenger }, select: SELECT });
    return ok(answer(user), 'auth.messengerSaved');
  }
}

function answer(user: { noticeMessenger: NoticeMessenger | null; linkedBotAccounts: Array<{ platform: SocialPlatform }> } | null): MeMessenger {
  return {
    messenger: user?.noticeMessenger ?? 'both',
    chosen: user?.noticeMessenger != null,
    linked: user?.linkedBotAccounts.map((l) => l.platform) ?? [],
  };
}
