import { InternalServerErrorException, Logger } from '@nestjs/common';
import { BotPlatform } from './bot-platform';
import { Invoice, invoiceParams, InvoiceRefusal } from './payment';

export interface TelegramLikeSendResult {
  ok: boolean;
  description?: string;
  error_code?: number;
  result?: { message_id?: number };
}

/** One button on an inline keyboard, in the two shapes both platforms take. */
export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; web_app: { url: string } };

/** `reply_markup` shapes this client knows how to send. */
export type ReplyMarkup =
  | { inline_keyboard: InlineButton[][] }
  | {
      keyboard: { text: string; request_contact?: boolean }[][];
      resize_keyboard?: boolean;
      one_time_keyboard?: boolean;
    }
  | { remove_keyboard: true };

/**
 * The update types the bot must receive.
 *
 * `callback_query` is not optional: every screen this bot renders is an inline
 * keyboard (`capabilities.ts` — both platforms have `inlineKeyboard`), so a
 * webhook registered without it delivers messages and silently swallows every
 * button tap. Registering `['message']` alone is what made login, register and
 * forgot-password unreachable by tapping.
 *
 * `pre_checkout_query` is not optional either (F-104-l): it is not a message,
 * so a registration without it never delivers the question, the bot never
 * answers it, and every in-chat payment times out. A bot registered before it
 * was added is rewritten once, on the next boot, by the same check.
 */
export const WEBHOOK_ALLOWED_UPDATES = [
  'message',
  'callback_query',
  'pre_checkout_query',
] as const;

/** Why an invoice was not sent: the rail's own refusal, or the platform said no. */
export type InvoiceFailure = InvoiceRefusal | 'platform_error';

/** What `getWebhookInfo` answers. */
export interface WebhookInfo {
  /** `''` when the platform has no webhook registered. */
  url: string;
  /** Empty means "the platform default", which is every type. */
  allowedUpdates: string[];
}

/**
 * Generic client for any bot exposing a Telegram-Bot-API-compatible
 * interface (Telegram itself and Bale). Implements the two calls the auth
 * flows need: delivering an OTP, and asking a chat to share its contact so
 * the account can be linked.
 */
export class TelegramLikeBotClient {
  private readonly logger: Logger;

  constructor(
    private readonly platformLabel: BotPlatform, // logs, and the invoice shape
    private readonly apiBase: string,
    private readonly botToken: string,
    private readonly timeoutMs: number,
  ) {
    this.logger = new Logger(`${TelegramLikeBotClient.name}:${platformLabel}`);
  }

  /** Returns the id of the message it sent, or `null` if the API did not say. */
  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: ReplyMarkup,
  ): Promise<number | null> {
    const result = await this.call<TelegramLikeSendResult>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });

    if (result.networkError) {
      this.logger.error(
        `network error sending to ${this.platformLabel} chatId=${chatId}: ${result.networkError}`,
      );
      throw new InternalServerErrorException(
        `otp.${this.platformLabel}SendFailed`,
      );
    }

    if (!result.ok) {
      this.logger.error(
        `${this.platformLabel} sendMessage failed for chatId=${chatId}: ` +
          `status=${result.status} description=${result.body?.description ?? 'n/a'}`,
      );
      throw new InternalServerErrorException(
        `otp.${this.platformLabel}SendFailed`,
      );
    }

    return result.body?.result?.message_id ?? null;
  }

  /**
   * Deletes one message. Both platforms allow a bot to delete an **incoming**
   * message in a private chat for 48 hours (verified 2026-09-06, see
   * `capabilities.ts`) — which is what lets a password typed in chat be taken
   * back out of the history.
   *
   * Never throws: the flow that asked has already used the message's content,
   * and a failure here is something to tell the user about, not to abort on.
   * `false` means "still in the chat" and the caller must say so.
   */
  async deleteMessage(chatId: string, messageId: number): Promise<boolean> {
    const result = await this.call<TelegramLikeSendResult>('deleteMessage', {
      chat_id: chatId,
      message_id: messageId,
    });
    if (!result.ok) {
      this.logger.warn(
        `${this.platformLabel} deleteMessage failed for chatId=${chatId}: ` +
          `status=${result.status} error=${result.networkError ?? result.body?.description ?? 'n/a'}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Acknowledges an inline-button tap. Both platforms expect this call even
   * when there is nothing to show the user; skipping it leaves a spinner on
   * the button.
   */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.call<TelegramLikeSendResult>('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  /**
   * Sends an invoice to the chat (F-104-l). The invoice is checked and shaped
   * for this platform first (`payment.ts`); a refusal calls nothing. Never
   * throws — a caller turns either failure into its own message.
   */
  async sendInvoice(
    chatId: string,
    invoice: Invoice,
  ): Promise<{ ok: true; messageId: number | null } | { ok: false; reason: InvoiceFailure }> {
    const shaped = invoiceParams(this.platformLabel, invoice);
    if ('reason' in shaped) return { ok: false, reason: shaped.reason };
    const result = await this.call<TelegramLikeSendResult>('sendInvoice', {
      chat_id: chatId,
      ...shaped.params,
    });
    if (!result.ok) {
      this.logInvoiceFailure('sendInvoice', result);
      return { ok: false, reason: 'platform_error' };
    }
    return { ok: true, messageId: result.body?.result?.message_id ?? null };
  }

  /**
   * An invoice a Mini App opens (F-104-l). On Telegram the result is a link;
   * on Bale it is the payment id its Mini App SDK takes. Either way the caller
   * hands it to the page as is.
   */
  async createInvoiceLink(
    invoice: Invoice,
  ): Promise<{ ok: true; link: string } | { ok: false; reason: InvoiceFailure }> {
    const shaped = invoiceParams(this.platformLabel, invoice);
    if ('reason' in shaped) return { ok: false, reason: shaped.reason };
    const result = await this.call<{ ok?: boolean; description?: string; result?: unknown }>(
      'createInvoiceLink',
      shaped.params,
    );
    const link = result.body?.result;
    if (!result.ok || typeof link !== 'string' || !link) {
      this.logInvoiceFailure('createInvoiceLink', result);
      return { ok: false, reason: 'platform_error' };
    }
    return { ok: true, link };
  }

  /**
   * Answers a `pre_checkout_query`. Both platforms allow 10 seconds, and a
   * refusal must carry the reason the payer reads. `false` means the answer
   * did not arrive — the platform then cancels the payment on its own.
   */
  async answerPreCheckoutQuery(
    queryId: string,
    verdict: { ok: true } | { ok: false; errorMessage: string },
  ): Promise<boolean> {
    const result = await this.call<TelegramLikeSendResult>('answerPreCheckoutQuery', {
      pre_checkout_query_id: queryId,
      ok: verdict.ok,
      ...('errorMessage' in verdict ? { error_message: verdict.errorMessage } : {}),
    });
    if (!result.ok) this.logInvoiceFailure('answerPreCheckoutQuery', result);
    return result.ok;
  }

  private logInvoiceFailure(
    method: string,
    result: { status: number; networkError?: string; body?: { description?: string } },
  ): void {
    this.logger.error(
      `${this.platformLabel} ${method} failed: status=${result.status} ` +
        `error=${result.networkError ?? result.body?.description ?? 'n/a'}`,
    );
  }

  /**
   * What the platform currently has registered: the URL it calls (`''` when it
   * has none) and the update types it was told to deliver. `null` means the
   * question could not be answered (network or API error) — which is not the
   * same as "no webhook", so callers must not overwrite on it.
   *
   * An **empty** `allowedUpdates` is the API's way of saying "the default set",
   * which already includes every type this bot needs. It is not the same as an
   * explicit narrow list, and the two must not be conflated: the explicit list
   * is exactly what once dropped every button tap.
   */
  async getWebhookInfo(): Promise<WebhookInfo | null> {
    const result = await this.call<
      TelegramLikeSendResult & {
        result?: { url?: string; allowed_updates?: string[] };
      }
    >('getWebhookInfo');
    if (!result.ok) {
      this.logger.warn(
        `${this.platformLabel} getWebhookInfo failed: status=${result.status} ` +
          `error=${result.networkError ?? result.body?.description ?? 'n/a'}`,
      );
      return null;
    }
    return {
      url: result.body?.result?.url ?? '',
      allowedUpdates: result.body?.result?.allowed_updates ?? [],
    };
  }

  /**
   * True when `info` will deliver everything the conversation needs. An empty
   * list is the platform default and covers all of it; a non-empty one has to
   * name each type.
   */
  static deliversEveryUpdate(allowedUpdates: string[]): boolean {
    if (!allowedUpdates.length) return true;
    return WEBHOOK_ALLOWED_UPDATES.every((u) => allowedUpdates.includes(u));
  }

  /**
   * Points the bot's updates at `url`. `secretToken` is a Telegram-only extra
   * header check; Bale ignores the field and is guarded by the secret in the
   * path alone. It is optional because a tenant may have none — the 32-byte
   * path is the credential either way — and omitting the field is not the same
   * as sending an empty one, which would clear a secret already registered.
   */
  async setWebhook(url: string, secretToken?: string): Promise<boolean> {
    const result = await this.call<TelegramLikeSendResult>('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: WEBHOOK_ALLOWED_UPDATES,
    });
    if (!result.ok) {
      this.logger.error(
        `${this.platformLabel} setWebhook failed: status=${result.status} ` +
          `error=${result.networkError ?? result.body?.description ?? 'n/a'}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Publishes the bot's command list, so `/menu` and `/help` appear in the
   * client's own command menu instead of being commands only a user who
   * already knows them can type. Per language: the list is what the user
   * reads, so it is translated like any other copy.
   *
   * Best-effort, like `setWebhook`: a bot whose command menu is stale still
   * works, because every command it names is also a button in the chat.
   */
  async setMyCommands(
    commands: Array<{ command: string; description: string }>,
    languageCode?: string,
  ): Promise<boolean> {
    const result = await this.call<TelegramLikeSendResult>('setMyCommands', {
      commands,
      ...(languageCode ? { language_code: languageCode } : {}),
    });
    if (!result.ok) {
      this.logger.warn(
        `${this.platformLabel} setMyCommands failed: status=${result.status} ` +
          `error=${result.networkError ?? result.body?.description ?? 'n/a'}`,
      );
    }
    return result.ok;
  }

  /**
   * One Bot API call. Never throws: every caller here has its own idea of
   * what a failure means, so the outcome is returned rather than raised.
   */
  private async call<T extends { ok?: boolean; description?: string }>(
    method: string,
    payload?: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    status: number;
    body?: T;
    networkError?: string;
  }> {
    const url = `${this.apiBase}/bot${this.botToken}/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
        signal: controller.signal,
      });
    } catch (e: any) {
      return { ok: false, status: 0, networkError: String(e?.message ?? e) };
    } finally {
      clearTimeout(timer);
    }

    let body: T | undefined;
    try {
      body = (await response.json()) as T;
    } catch {
      // If the body isn't JSON, decide based on status code alone.
    }

    return {
      ok: response.ok && body?.ok !== false,
      status: response.status,
      body,
    };
  }

  /**
   * Asks a chat to share its own contact. The button is the only way to get a
   * contact the platform itself vouches for: a hand-built contact can carry
   * any phone number, which is why the caller still has to compare
   * `contact.user_id` with the sender's id.
   */
  requestContact(
    chatId: string,
    text: string,
    buttonLabel: string,
  ): Promise<number | null> {
    return this.sendMessage(chatId, text, {
      keyboard: [[{ text: buttonLabel, request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    });
  }

  /** Sends `text` and takes the contact keyboard back down. */
  clearKeyboard(chatId: string, text: string): Promise<number | null> {
    return this.sendMessage(chatId, text, { remove_keyboard: true });
  }
}
