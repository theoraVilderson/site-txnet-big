import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { LocaleService } from '../../locale/locale.service';
import {
  IOtpService,
  OtpChannel,
  OtpPurpose,
  OTP_SERVICE,
} from '../otp/otp.interface';
import {
  BOT_PLATFORMS,
  BotClientRegistry,
  BotPlatform,
} from '../otp/senders/bot-client.registry';
import { BotLinkStore } from './bot-link.store';
import { botLinkMessage } from './bot-link.messages';
import { BotContact, BotUpdate, PendingBotLink } from './bot-link.types';

/** A messenger channel and the platform behind it are the same thing. */
const CHANNEL_OF: Record<BotPlatform, OtpChannel> = {
  telegram: OtpChannel.telegram,
  bale: OtpChannel.bale,
};

export interface StartedBotLink {
  linkRequired: true;
  platform: BotPlatform;
  linkToken: string;
  deepLink: string;
  expiresIn: number;
}

export interface BotLinkStatus {
  state: PendingBotLink['state'];
  otpSent: boolean;
  failureKey?: string;
}

/**
 * Links a User's Telegram/Bale account to their phone number, with the
 * messenger itself as the witness.
 *
 * The whole point is the contact check in `handleContact`. A shared contact
 * carries a phone number *and* the id of the account it describes; an
 * unofficial client can put any number on a contact card, but it cannot make
 * that card claim the sender's own id. So a contact is only proof when
 * `contact.user_id === message.from.id` — and only then is the number it
 * carries allowed to bind a chat id to an account that can receive OTPs.
 */
@Injectable()
export class BotLinkService {
  private readonly logger = new Logger(BotLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: BotLinkStore,
    private readonly bots: BotClientRegistry,
    private readonly locale: LocaleService,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
  ) {}

  /** Whether this platform can run the link flow (token + username + secret). */
  canLink(platform: BotPlatform): boolean {
    return this.bots.canLink(platform);
  }

  /**
   * Does the account behind `phoneNumber` already have a contact-verified link
   * for this platform? If it does, the OTP goes straight out and the user is
   * never asked for their contact again.
   *
   * A phone with no account answers `false` — the caller must not branch on
   * the difference, or the answer becomes an account-existence oracle.
   */
  async hasVerifiedLink(
    phoneNumber: string,
    platform: BotPlatform,
  ): Promise<boolean> {
    const link = await this.prisma.linkedBotAccount.findFirst({
      where: {
        platform,
        contactVerifiedAt: { not: null },
        user: { phoneNumber, deletedAt: null },
      },
      select: { id: true },
    });
    if (link) return true;
    // A registration that has already proven its chat but has no `user` row
    // yet is just as linked, as far as "can this code be delivered?" goes.
    return (await this.store.provenChat(platform, phoneNumber)) !== null;
  }

  /**
   * Turns the parked proof into a real `linked_bot_account`. Called by
   * `verify-phone`, the moment the `user` row exists.
   */
  async promoteProvenChat(userId: string, phoneNumber: string): Promise<void> {
    for (const platform of BOT_PLATFORMS) {
      const chatId = await this.store.provenChat(platform, phoneNumber);
      if (!chatId) continue;
      await this.prisma.linkedBotAccount.upsert({
        where: { userId_platform: { userId, platform } },
        create: {
          userId,
          platform,
          platformUserId: chatId,
          phoneNumber,
          contactVerifiedAt: new Date(),
        },
        update: {
          platformUserId: chatId,
          phoneNumber,
          contactVerifiedAt: new Date(),
        },
      });
      await this.store.clearProvenChat(platform, phoneNumber);
    }
  }

  /**
   * Issues (or re-issues) the deep link that starts the bot conversation.
   * Called for any phone number the client names, existing account or not —
   * refusing early would tell an anonymous caller which numbers are
   * registered.
   */
  async startLink(input: {
    platform: BotPlatform;
    phoneNumber: string;
    purpose: OtpPurpose;
    lang: string;
    ip: string;
  }): Promise<StartedBotLink> {
    if (!this.canLink(input.platform)) {
      throw new BadRequestException('otp.channelNotConfigured');
    }

    // Re-asking inside the TTL hands back the same link: a second deep link
    // would orphan the one the user may already have open in the messenger.
    const existing = await this.store.byPhone(input.platform, input.phoneNumber);
    const link: PendingBotLink = existing ?? {
      token: randomBytes(24).toString('base64url'),
      platform: input.platform,
      phoneNumber: input.phoneNumber,
      purpose: input.purpose,
      lang: input.lang,
      ip: input.ip,
      state: 'pending',
      otpSent: false,
      createdAt: Date.now(),
    };
    // The purpose can legitimately change between two requests for the same
    // number (login, then password reset) — the link itself is unchanged.
    link.purpose = input.purpose;
    link.lang = input.lang;
    await this.store.save(link);

    const deepLink = this.bots.deepLink(input.platform, link.token);
    if (!deepLink) throw new BadRequestException('otp.channelNotConfigured');

    return {
      linkRequired: true,
      platform: input.platform,
      linkToken: link.token,
      deepLink,
      expiresIn: this.store.ttlSeconds,
    };
  }

  /** What the waiting client polls for. */
  async status(token: string): Promise<BotLinkStatus> {
    const link = await this.store.byToken(token);
    if (!link) return { state: 'failed', otpSent: false, failureKey: 'otp.botLink.expired' };
    return {
      state: link.state,
      otpSent: link.otpSent,
      ...(link.failureKey ? { failureKey: link.failureKey } : {}),
    };
  }

  /**
   * Entry point for a webhook update. Never throws and never reports failure
   * to the platform: an error status makes Telegram/Bale redeliver the same
   * update, and a duplicated `/start` is noise at best.
   */
  async handleUpdate(platform: BotPlatform, update: BotUpdate): Promise<void> {
    try {
      const message = update?.message;
      if (!message?.chat?.id || message.from?.is_bot) return;
      const chatId = String(message.chat.id);

      if (message.contact) {
        await this.handleContact(platform, chatId, message.from?.id, message.contact);
        return;
      }
      if (typeof message.text === 'string') {
        await this.handleText(platform, chatId, message.text, message.from?.language_code);
      }
    } catch (e: unknown) {
      this.logger.error(
        `${platform} update handling failed: ${
          e instanceof Error ? (e.stack ?? e.message) : String(e)
        }`,
      );
    }
  }

  // --- conversation -------------------------------------------------------

  private async handleText(
    platform: BotPlatform,
    chatId: string,
    text: string,
    languageCode?: string,
  ): Promise<void> {
    const startToken = /^\/start(?:@\S+)?(?:\s+(\S+))?/.exec(text.trim())?.[1];
    if (!startToken) {
      await this.reply(platform, chatId, this.fallbackLang(languageCode), 'unknownCommand');
      return;
    }

    const link = await this.store.byToken(startToken);
    if (!link || link.platform !== platform) {
      await this.reply(platform, chatId, this.fallbackLang(languageCode), 'expired');
      return;
    }

    // Already linked from this very chat: the user pressed the link again, or
    // came back later. Skip the contact step entirely and just send the code.
    const alreadyLinked = await this.prisma.linkedBotAccount.findFirst({
      where: {
        platform,
        platformUserId: chatId,
        contactVerifiedAt: { not: null },
        user: { phoneNumber: link.phoneNumber, deletedAt: null },
      },
      select: { id: true },
    });
    if (alreadyLinked) {
      await this.store.bindChat(platform, chatId, link.token);
      await this.completeLink(platform, chatId, link);
      return;
    }

    await this.store.bindChat(platform, chatId, link.token);
    const client = this.bots.client(platform);
    await client?.requestContact(
      chatId,
      botLinkMessage(this.locale, link.lang, 'askContact'),
      botLinkMessage(this.locale, link.lang, 'askContactButton'),
    );
  }

  private async handleContact(
    platform: BotPlatform,
    chatId: string,
    senderId: number | string | undefined,
    contact: BotContact,
  ): Promise<void> {
    const link = await this.store.byChat(platform, chatId);
    if (!link) {
      await this.reply(platform, chatId, this.fallbackLang(), 'expired');
      return;
    }

    // ── The ownership proof. A contact card can carry any phone number; it
    // cannot carry a `user_id` other than its real owner's. If the card
    // describes someone other than the person who sent it, the number on it
    // says nothing about the sender.
    if (!contact.user_id || String(contact.user_id) !== String(senderId)) {
      this.logger.warn(
        `${platform}: contact sent by ${senderId} describes ${contact.user_id ?? 'nobody'} — rejected`,
      );
      await this.fail(platform, chatId, link, 'senderMismatch', 'otp.botLink.senderMismatch');
      return;
    }

    const shared = normalizeMessengerPhone(contact.phone_number);
    if (!shared || shared !== link.phoneNumber) {
      await this.fail(platform, chatId, link, 'phoneMismatch', 'otp.botLink.phoneMismatch');
      return;
    }

    // One messenger account, one platform account.
    const takenBySomeoneElse = await this.prisma.linkedBotAccount.findFirst({
      where: {
        platform,
        platformUserId: chatId,
        user: { phoneNumber: { not: link.phoneNumber } },
      },
      select: { id: true },
    });
    if (takenBySomeoneElse) {
      await this.fail(
        platform,
        chatId,
        link,
        'takenByAnotherAccount',
        'otp.botLink.takenByAnotherAccount',
      );
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { phoneNumber: link.phoneNumber, deletedAt: null },
      select: { id: true },
    });

    if (!user) {
      // Registration: there is deliberately no `user` row until the phone OTP
      // is verified (identity/invariants.md #11), so the proof is parked in
      // Redis and `verify-phone` turns it into a `linked_bot_account` at the
      // moment the user is created.
      if (link.purpose === OtpPurpose.register_phone_verify) {
        await this.store.saveProvenChat(platform, link.phoneNumber, chatId);
        await this.completeLink(platform, chatId, link);
        return;
      }
      // Otherwise the sender has proven this number is theirs, so telling them
      // it has no account reveals nothing they could not already establish.
      await this.fail(platform, chatId, link, 'noAccount', 'otp.botLink.noAccount');
      return;
    }

    await this.prisma.linkedBotAccount.upsert({
      where: { userId_platform: { userId: user.id, platform } },
      create: {
        userId: user.id,
        platform,
        platformUserId: chatId,
        phoneNumber: shared,
        contactVerifiedAt: new Date(),
      },
      update: {
        platformUserId: chatId,
        phoneNumber: shared,
        contactVerifiedAt: new Date(),
      },
    });

    await this.completeLink(platform, chatId, link);
  }

  /** Link is good: record it, take the keyboard down, send the code. */
  private async completeLink(
    platform: BotPlatform,
    chatId: string,
    link: PendingBotLink,
  ): Promise<void> {
    link.state = 'linked';
    delete link.failureKey;

    let sent = false;
    if (link.purpose !== OtpPurpose.account_link) {
      try {
        await this.otp.issueOtp(
          link.phoneNumber,
          link.purpose,
          CHANNEL_OF[platform],
          link.ip,
          link.lang,
        );
        sent = true;
      } catch (e: unknown) {
        // A cooldown or a send failure must not undo a good link — the user
        // can ask for the code again from the site.
        this.logger.warn(
          `${platform}: link completed but OTP not sent: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    link.otpSent = sent;
    await this.store.update(link);
    await this.store.releaseChat(platform, chatId);

    const client = this.bots.client(platform);
    await client?.clearKeyboard(
      chatId,
      botLinkMessage(this.locale, link.lang, sent ? 'linked' : 'linkedNoCode'),
    );
  }

  private async fail(
    platform: BotPlatform,
    chatId: string,
    link: PendingBotLink,
    messageKey: Parameters<typeof botLinkMessage>[2],
    failureKey: string,
  ): Promise<void> {
    link.state = 'failed';
    link.failureKey = failureKey;
    await this.store.update(link);
    await this.reply(platform, chatId, link.lang, messageKey);
  }

  private async reply(
    platform: BotPlatform,
    chatId: string,
    lang: string,
    messageKey: Parameters<typeof botLinkMessage>[2],
  ): Promise<void> {
    const client = this.bots.client(platform);
    await client?.sendMessage(
      chatId,
      botLinkMessage(this.locale, lang, messageKey),
    );
  }

  /** Language for a chat we have no pending record for. */
  private fallbackLang(languageCode?: string): string {
    return languageCode?.toLowerCase().startsWith('fa') ? 'fa' : 'en';
  }
}

/**
 * Messengers report a contact's number in whatever shape the account was
 * registered with (`989…`, `+989…`, `09…`). Normalize to the `09xxxxxxxxx`
 * form the rest of identity stores, or `null` if it is not an Iranian mobile.
 */
export function normalizeMessengerPhone(raw: string): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  const national = digits.startsWith('0098')
    ? digits.slice(4)
    : digits.startsWith('98')
      ? digits.slice(2)
      : digits.startsWith('0')
        ? digits.slice(1)
        : digits;
  return /^9\d{9}$/.test(national) ? `0${national}` : null;
}
