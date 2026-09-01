import { InternalServerErrorException, Logger } from '@nestjs/common';

export interface TelegramLikeSendResult {
  ok: boolean;
  description?: string;
  error_code?: number;
}

/**
 * Generic client for any bot exposing a Telegram-Bot-API-compatible
 * interface (Telegram itself and Bale). Only implements sendMessage,
 * since that's all that's needed to deliver OTP codes.
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

  async sendMessage(chatId: string, text: string): Promise<void> {
    const url = `${this.apiBase}/bot${this.botToken}/sendMessage`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
        }),
        signal: controller.signal,
      });
    } catch (e: any) {
      this.logger.error(
        `network error sending to ${this.platformLabel} chatId=${chatId}: ${e?.message ?? e}`,
      );
      throw new InternalServerErrorException(
        `otp.${this.platformLabel}SendFailed`,
      );
    } finally {
      clearTimeout(timer);
    }

    let body: TelegramLikeSendResult | undefined;
    try {
      body = (await response.json()) as TelegramLikeSendResult;
    } catch {
      // If the body isn't JSON, decide based on status code alone.
    }

    if (!response.ok || (body && body.ok === false)) {
      this.logger.error(
        `${this.platformLabel} sendMessage failed for chatId=${chatId}: ` +
          `status=${response.status} description=${body?.description ?? 'n/a'}`,
      );
      throw new InternalServerErrorException(
        `otp.${this.platformLabel}SendFailed`,
      );
    }
  }
}
