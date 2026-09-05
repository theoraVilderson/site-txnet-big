import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramLikeBotClient } from './telegram-like-bot.client';

/** The messenger platforms that speak the Telegram Bot API shape. */
export type BotPlatform = 'telegram' | 'bale';

export const BOT_PLATFORMS: readonly BotPlatform[] = ['telegram', 'bale'];

interface BotConfig {
  client: TelegramLikeBotClient | null;
  username?: string;
  deepLinkBase: string;
  webhookSecret?: string;
}

/**
 * One place that turns env vars into a bot client per platform. Both the OTP
 * senders and the account-link flow talk to the same bot, so neither owns the
 * token: a bot that is not configured here is simply not offered as a channel.
 */
@Injectable()
export class BotClientRegistry {
  private readonly logger = new Logger(BotClientRegistry.name);
  private readonly bots: Record<BotPlatform, BotConfig>;

  constructor(private readonly config: ConfigService) {
    const timeoutMs = this.config.get<number>('OTP_BOT_HTTP_TIMEOUT_MS', 5000);

    const build = (
      platform: BotPlatform,
      tokenKey: string,
      apiBaseKey: string,
      apiBaseDefault: string,
      usernameKey: string,
      deepLinkKey: string,
      deepLinkDefault: string,
      secretKey: string,
    ): BotConfig => {
      const token = this.config.get<string>(tokenKey);
      if (!token) {
        this.logger.log(`${platform}: ${tokenKey} unset — channel disabled`);
      }
      return {
        client: token
          ? new TelegramLikeBotClient(
              platform,
              // A trailing slash would build `…//bot<token>/…`, which some
              // API hosts (and proxies in front of them) answer with 404.
              this.config
                .get<string>(apiBaseKey, apiBaseDefault)
                .replace(/\/+$/, ''),
              token,
              timeoutMs,
            )
          : null,
        username: this.config.get<string>(usernameKey),
        deepLinkBase: this.config
          .get<string>(deepLinkKey, deepLinkDefault)
          .replace(/\/+$/, ''),
        webhookSecret: this.config.get<string>(secretKey),
      };
    };

    this.bots = {
      telegram: build(
        'telegram',
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_API_BASE',
        'https://api.telegram.org',
        'TELEGRAM_BOT_USERNAME',
        'TELEGRAM_DEEP_LINK_BASE',
        'https://t.me',
        'TELEGRAM_WEBHOOK_SECRET',
      ),
      bale: build(
        'bale',
        'BALE_BOT_TOKEN',
        'BALE_API_BASE',
        'https://tapi.bale.ai',
        'BALE_BOT_USERNAME',
        'BALE_DEEP_LINK_BASE',
        'https://ble.ir',
        'BALE_WEBHOOK_SECRET',
      ),
    };
  }

  client(platform: BotPlatform): TelegramLikeBotClient | null {
    return this.bots[platform].client;
  }

  webhookSecret(platform: BotPlatform): string | undefined {
    return this.bots[platform].webhookSecret;
  }

  /**
   * Whether this platform can run the link flow at all. Delivering an OTP only
   * needs a token; *linking* also needs the bot's username, because without it
   * there is no deep link to send the user to.
   */
  canLink(platform: BotPlatform): boolean {
    const bot = this.bots[platform];
    return Boolean(bot.client && bot.username && bot.webhookSecret);
  }

  /** `https://t.me/<bot>?start=<token>` — the same shape on both platforms. */
  deepLink(platform: BotPlatform, startToken: string): string | null {
    const bot = this.bots[platform];
    if (!bot.username) return null;
    return `${bot.deepLinkBase}/${bot.username}?start=${startToken}`;
  }
}
