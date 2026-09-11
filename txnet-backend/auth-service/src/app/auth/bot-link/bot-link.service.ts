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
import { OtpDeliveryStore } from '../otp/otp-delivery.store';
import {
  BOT_PLATFORMS,
  BotClientRegistry,
  BotPlatform,
} from '@txnet-backend/messenger';
import { BotLinkStore } from './bot-link.store';
import { BotLinkMessageKey, botLinkMessage } from './bot-link.messages';
import { BotContact, BotUpdate, PendingBotLink } from './bot-link.types';
import { parsePhone } from '../../common/validation/phone.schema';
import { TenantContext } from '../../tenant-context/tenant-context';

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
 * What one step of the link conversation decided, with nothing rendered.
 *
 * Two surfaces drive this flow — the deprecated in-service webhook and
 * `bot-service` over `/auth/bots/link/*` (ADR-0011) — and the rule behind
 * invariant #12 must be enforced in exactly one place, so the decision is
 * returned rather than sent. `messageKey` is an `otp.botLink.*` key: the caller
 * translates it and decides what a keyboard looks like.
 */
export interface BotLinkOutcome {
  state: PendingBotLink['state'];
  /** The chat must share its contact before anything else can happen. */
  needsContact: boolean;
  otpSent: boolean;
  messageKey: BotLinkMessageKey;
  failureKey?: string;
  lang: string;
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
    private readonly deliveries: OtpDeliveryStore,
  ) {}

  /** Whether the tenant in scope can run the link flow on this platform. */
  canLink(platform: BotPlatform): Promise<boolean> {
    const tenantId = TenantContext.currentOrNull()?.id;
    if (!tenantId) return Promise.resolve(false);
    return this.bots.canLink(tenantId, platform);
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
          // The ambient tenant is the one `withTenant` would inject anyway
          // (F-066-l); Prisma's create input has no way to know that, so the
          // three link writes name it. It is the user's own tenant by
          // construction — the user was created, or found, in this scope.
          tenantId: TenantContext.current('a bot link').id,
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
    // The tenant's own bot, resolved once: it is both the check that the
    // channel can run at all and the bot the deep link has to point at.
    const integration = await this.bots.primaryFor(
      TenantContext.current('a bot link').id,
      input.platform,
    );
    if (
      !integration?.botUsername ||
      !(await this.bots.hasToken(integration))
    ) {
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

    const deepLink = this.bots.deepLink(integration, link.token);
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
   *
   * @deprecated since 2026-09-06 — `bot-service` owns the webhook (ADR-0011)
   * and calls `resolveStart` / `submitContact` through `/auth/bots/link/*`.
   * Kept working for one release so a bot pointed at the old URL still links.
   */
  async handleUpdate(platform: BotPlatform, update: BotUpdate): Promise<void> {
    try {
      const message = update?.message;
      if (!message?.chat?.id || message.from?.is_bot) return;
      const chatId = String(message.chat.id);

      if (message.contact) {
        const outcome = await this.submitContact(
          platform,
          chatId,
          message.from?.id,
          message.contact,
        );
        await this.render(platform, chatId, outcome);
        return;
      }
      if (typeof message.text === 'string') {
        const startToken = /^\/start(?:@\S+)?(?:\s+(\S+))?/.exec(
          message.text.trim(),
        )?.[1];
        const outcome = await this.resolveStart(
          platform,
          chatId,
          startToken,
          message.from?.language_code,
        );
        await this.render(platform, chatId, outcome);
      }
    } catch (e: unknown) {
      this.logger.error(
        `${platform} update handling failed: ${
          e instanceof Error ? (e.stack ?? e.message) : String(e)
        }`,
      );
    }
  }

  // --- conversation: decides, renders nothing -----------------------------

  /**
   * The chat opened the bot with `?start=<token>`. Answers what has to happen
   * next: ask for the contact, or (for a chat already linked to this number)
   * go straight to the code.
   */
  async resolveStart(
    platform: BotPlatform,
    chatId: string,
    startToken: string | undefined,
    languageCode?: string,
  ): Promise<BotLinkOutcome> {
    if (!startToken) {
      return this.plain('unknownCommand', this.fallbackLang(languageCode));
    }

    const link = await this.store.byToken(startToken);
    if (!link || link.platform !== platform) {
      return this.plain('expired', this.fallbackLang(languageCode));
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
      return this.completeLink(platform, chatId, link);
    }

    await this.store.bindChat(platform, chatId, link.token);
    return {
      state: link.state,
      needsContact: true,
      otpSent: false,
      messageKey: 'askContact',
      lang: link.lang,
    };
  }

  /**
   * The chat shared a contact. This is the ownership proof behind invariant
   * #12 and it lives here alone — no other surface may re-implement it.
   */
  async submitContact(
    platform: BotPlatform,
    chatId: string,
    senderId: number | string | undefined,
    contact: BotContact,
  ): Promise<BotLinkOutcome> {
    const link = await this.store.byChat(platform, chatId);
    if (!link) return this.plain('expired', this.fallbackLang());

    // ── The ownership proof. A contact card can carry any phone number; it
    // cannot carry a `user_id` other than its real owner's. If the card
    // describes someone other than the person who sent it, the number on it
    // says nothing about the sender.
    if (!contact.user_id || String(contact.user_id) !== String(senderId)) {
      this.logger.warn(
        `${platform}: contact sent by ${senderId} describes ${contact.user_id ?? 'nobody'} — rejected`,
      );
      return this.fail(link, 'senderMismatch', 'otp.botLink.senderMismatch');
    }

    const shared = normalizeMessengerPhone(contact.phone_number);
    if (!shared || shared !== link.phoneNumber) {
      return this.fail(link, 'phoneMismatch', 'otp.botLink.phoneMismatch');
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
      return this.fail(
        link,
        'takenByAnotherAccount',
        'otp.botLink.takenByAnotherAccount',
      );
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
        return this.completeLink(platform, chatId, link);
      }
      // Otherwise the sender has proven this number is theirs, so telling them
      // it has no account reveals nothing they could not already establish.
      return this.fail(link, 'noAccount', 'otp.botLink.noAccount');
    }

    await this.prisma.linkedBotAccount.upsert({
      where: { userId_platform: { userId: user.id, platform } },
      create: {
        tenantId: TenantContext.current('a bot link').id,
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

    return this.completeLink(platform, chatId, link);
  }

  /** Link is good: record it, send the code. */
  private async completeLink(
    platform: BotPlatform,
    chatId: string,
    link: PendingBotLink,
  ): Promise<BotLinkOutcome> {
    link.state = 'linked';
    delete link.failureKey;

    let sent = false;
    if (link.purpose !== OtpPurpose.account_link) {
      try {
        // Handles with no reader: this send is triggered by the user sharing
        // their contact in the chat, so there is no HTTP caller holding a 202
        // to hand them to and nobody can subscribe to the channel. The status
        // is still written, and it is what `link.otpSent` reports through
        // `/auth/bots/link/status`, which this flow polls. Giving *this* flow
        // a socket is a separate change: the client here is the screen showing
        // a deep link, and it never received a channel token.
        await this.otp.issueOtp(
          link.phoneNumber,
          link.purpose,
          CHANNEL_OF[platform],
          link.ip,
          link.lang,
          await this.deliveries.mintHandles(),
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

    return {
      state: 'linked',
      needsContact: false,
      otpSent: sent,
      messageKey: sent ? 'linked' : 'linkedNoCode',
      lang: link.lang,
    };
  }

  private async fail(
    link: PendingBotLink,
    messageKey: BotLinkMessageKey,
    failureKey: string,
  ): Promise<BotLinkOutcome> {
    link.state = 'failed';
    link.failureKey = failureKey;
    await this.store.update(link);
    return {
      state: 'failed',
      needsContact: false,
      otpSent: false,
      messageKey,
      failureKey,
      lang: link.lang,
    };
  }

  /** An answer that changed no state — an expired token, an unknown command. */
  private plain(messageKey: BotLinkMessageKey, lang: string): BotLinkOutcome {
    return {
      state: 'failed',
      needsContact: false,
      otpSent: false,
      messageKey,
      failureKey: messageKey === 'expired' ? 'otp.botLink.expired' : undefined,
      lang,
    };
  }

  /** Says the outcome out loud, for the surface that owns the webhook itself. */
  private async render(
    platform: BotPlatform,
    chatId: string,
    outcome: BotLinkOutcome,
  ): Promise<void> {
    const client = await this.bots.primaryClient(
      TenantContext.current('a bot link reply').id,
      platform,
      'identity:BotLinkService',
    );
    if (!client) return;
    const text = botLinkMessage(this.locale, outcome.lang, outcome.messageKey);

    if (outcome.needsContact) {
      await client.requestContact(
        chatId,
        text,
        botLinkMessage(this.locale, outcome.lang, 'askContactButton'),
      );
      return;
    }
    if (outcome.state === 'linked') {
      await client.clearKeyboard(chatId, text);
      return;
    }
    await client.sendMessage(chatId, text);
  }

  /**
   * Language for a chat we have no pending record for — the only case where
   * `link.lang` (what the panel was speaking when the link was made) is not
   * available.
   *
   * `languageCode` is the sender's *phone* setting, so it answers last, not
   * first (ADR-0016): this deployment's `DEFAULT_LANGUAGE` wins, and the hint is
   * reached only if locale-service does not serve it. That is the same order
   * bot-service applies in `locale/chat-language.ts`; the one step missing here
   * is the chat's own `/lang` choice, which lives in bot-service's Redis and
   * this service cannot see.
   */
  private fallbackLang(languageCode?: string): string {
    const configured = this.locale.getDefaultLanguage();
    const served = this.locale.getAvailableLanguages();
    // An empty list means the first snapshot has not landed; refusing every
    // language would be worse than trusting the configuration.
    if (served.length === 0 || served.includes(configured)) return configured;
    return this.locale.resolveLanguage(languageCode);
  }
}

/**
 * Messengers report a contact's number in whatever shape the account was
 * registered with, and Telegram in particular drops the `+`: `989…`,
 * `+989…`, `09…` all arrive. Normalize to the E.164 form the rest of
 * identity stores (ADR-0018), or `null` if it is not a number that can hold
 * an account here.
 *
 * Two readings are tried, in this order, because they genuinely differ: a
 * bare `4915112345678` is a German number written internationally without
 * its `+`, but a bare `09121234567` is national. Reading it as national
 * first, then as international, is what makes both work without a
 * per-country branch.
 */
export function normalizeMessengerPhone(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/\D/g, '');
  return (
    parsePhone(trimmed) ??
    (digits ? parsePhone(`+${digits}`) : undefined) ??
    null
  );
}
