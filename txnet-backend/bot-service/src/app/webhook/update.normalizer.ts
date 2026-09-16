import { Injectable } from '@nestjs/common';
import {
  BotIntegration,
  BotPlatform,
  BotUpdate,
  parsePaymentEvent,
} from '@txnet-backend/messenger';
import { LocaleService } from '../locale/locale.service';
import { ChatContext } from '../conversation/nav.types';

/**
 * Turns whatever a platform posted into the one shape the flows understand.
 * This is the last place in `bot-service` that knows what a Telegram `Update`
 * looks like — everything above it speaks `ChatContext` and `BotView`.
 */
@Injectable()
export class UpdateNormalizer {
  constructor(private readonly locale: LocaleService) {}

  /**
   * `integration` is carried, not derived: it was resolved from the webhook
   * path before this update was parsed, and every call the flows go on to make
   * names its tenant (F-320). Nothing here may read a tenant out of `update` —
   * that is the body, and the body is written by the sender.
   */
  normalize(
    platform: BotPlatform,
    integration: BotIntegration,
    update: BotUpdate,
  ): ChatContext | null {
    // A payment the messenger reported (F-104-l, F-104-m). A pre-checkout query
    // has no chat of its own: an invoice is sent to a private chat, whose id
    // is the payer's.
    const payment = update ? parsePaymentEvent(update) : null;
    if (payment?.kind === 'pre_checkout') {
      return {
        platform,
        integration,
        chatId: payment.fromId,
        senderId: payment.fromId,
        lang: this.lang(update.pre_checkout_query?.from?.language_code),
        payment,
      };
    }

    const callback = update?.callback_query;
    if (callback?.message?.chat?.id) {
      return {
        platform,
        integration,
        chatId: String(callback.message.chat.id),
        senderId: callback.from?.id,
        lang: this.lang(callback.from?.language_code),
        callbackData: callback.data,
        callbackQueryId: callback.id,
      };
    }

    const message = update?.message;
    // A bot talking to a bot is not a user, and a message with no chat is not
    // addressable — both are dropped rather than answered.
    if (!message?.chat?.id || message.from?.is_bot) return null;

    return {
      platform,
      integration,
      chatId: String(message.chat.id),
      senderId: message.from?.id,
      lang: this.lang(message.from?.language_code),
      text: typeof message.text === 'string' ? message.text : undefined,
      contact: message.contact,
      messageId: message.message_id,
      ...(payment ? { payment } : {}),
    };
  }

  /**
   * The messenger's own language hint, resolved against the languages
   * locale-service actually serves — never trusted verbatim.
   */
  private lang(languageCode?: string): string {
    return this.locale.resolveLanguage(languageCode);
  }
}
