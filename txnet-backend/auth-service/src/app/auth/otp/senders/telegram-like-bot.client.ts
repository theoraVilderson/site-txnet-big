import { InternalServerErrorException, Logger } from '@nestjs/common';

export interface TelegramLikeSendResult {
  ok: boolean;
  description?: string;
  error_code?: number;
}

/** `reply_markup` shapes this client knows how to send. */
export type ReplyMarkup =
  | {
      keyboard: { text: string; request_contact?: boolean }[][];
      resize_keyboard?: boolean;
      one_time_keyboard?: boolean;
    }
  | { remove_keyboard: true };

/**
 * Generic client for any bot exposing a Telegram-Bot-API-compatible
 * interface (Telegram itself and Bale). Implements the two calls the auth
 * flows need: delivering an OTP, and asking a chat to share its contact so
 * the account can be linked.
 */
export class TelegramLikeBotClient {
  private readonly logger: Logger;

  constructor(
    private readonly platformLabel: string, // for logs only: 'telegram' | 'bale'
    private readonly apiBase: string,
    private readonly botToken: string,
    private readonly timeoutMs: number,
  ) {
    this.logger = new Logger(`${TelegramLikeBotClient.name}:${platformLabel}`);
  }

  async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: ReplyMarkup,
  ): Promise<void> {
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
  }

  /**
   * The webhook URL the platform currently calls, `''` when it has none.
   * `null` means the question could not be answered (network or API error) —
   * which is not the same as "no webhook", so callers must not overwrite on
   * it.
   */
  async getWebhookUrl(): Promise<string | null> {
    const result = await this.call<
      TelegramLikeSendResult & { result?: { url?: string } }
    >('getWebhookInfo');
    if (!result.ok) {
      this.logger.warn(
        `${this.platformLabel} getWebhookInfo failed: status=${result.status} ` +
          `error=${result.networkError ?? result.body?.description ?? 'n/a'}`,
      );
      return null;
    }
    return result.body?.result?.url ?? '';
  }

  /**
   * Points the bot's updates at `url`. `secretToken` is a Telegram-only extra
   * header check; Bale ignores the field and is guarded by the secret in the
   * path alone.
   */
  async setWebhook(url: string, secretToken: string): Promise<boolean> {
    const result = await this.call<TelegramLikeSendResult>('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message'],
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
  ): Promise<void> {
    return this.sendMessage(chatId, text, {
      keyboard: [[{ text: buttonLabel, request_contact: true }]],
      resize_keyboard: true,
      one_time_keyboard: true,
    });
  }

  /** Sends `text` and takes the contact keyboard back down. */
  clearKeyboard(chatId: string, text: string): Promise<void> {
    return this.sendMessage(chatId, text, { remove_keyboard: true });
  }
}
