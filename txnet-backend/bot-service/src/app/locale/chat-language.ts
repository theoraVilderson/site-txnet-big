import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotPlatform } from '@txnet-backend/messenger';
import { RedisKeys, RedisTtl } from '../redis/redis.keys';
import { RedisService } from '../redis/redis.service';
import { LocaleService } from './locale.service';

/**
 * Which language a chat is spoken to in.
 *
 * The messenger hands over `from.language_code` — the language that user's
 * *Telegram or Bale app* is set to. That is a hint about their phone, not a
 * statement about the product: a reseller selling in Iran to a customer whose
 * Telegram is English had no way to be understood, and the customer had no way
 * to ask. So the hint is the last word, not the first (user decision,
 * 2026-09-06):
 *
 * 1. **what the user chose** in the bot, kept in Redis and re-armed on every
 *    message;
 * 2. **this deployment's default** (`BOT_DEFAULT_LANGUAGE`) — a tenant sells
 *    in a language, and that outranks a phone setting;
 * 3. **the messenger's hint**, resolved against the languages
 *    `locale-service` actually serves;
 * 4. `DEFAULT_LANGUAGE`, which is what `resolveLanguage` already falls back to.
 *
 * `BOT_DEFAULT_LANGUAGE` is left unset when a deployment would rather follow
 * the user's phone — that is the whole reason it is separate from
 * `DEFAULT_LANGUAGE`, which is a last resort and is always set.
 */
@Injectable()
export class ChatLanguage {
  private readonly logger = new Logger(ChatLanguage.name);
  private readonly ttl: number;
  private readonly tenantDefault?: string;

  constructor(
    private readonly redis: RedisService,
    private readonly locale: LocaleService,
    config: ConfigService,
  ) {
    this.ttl = config.get<number>('BOT_LANG_TTL_SEC', RedisTtl.botLang);
    this.tenantDefault = config.get<string>('BOT_DEFAULT_LANGUAGE') || undefined;
  }

  /**
   * The language for this message. `hint` is what the normalizer resolved out
   * of the update, so a chat that has never chosen and a deployment with no
   * default keep exactly the behaviour they had.
   */
  async resolve(
    platform: BotPlatform,
    chatId: string,
    hint: string,
  ): Promise<string> {
    const chosen = await this.chosen(platform, chatId);
    if (chosen) return chosen;
    if (this.tenantDefault && this.serves(this.tenantDefault)) {
      return this.tenantDefault;
    }
    if (this.tenantDefault) {
      this.logger.warn(
        `BOT_DEFAULT_LANGUAGE=${this.tenantDefault} is not served by locale-service — falling back to the messenger's own language`,
      );
    }
    return hint;
  }

  /** What this chat picked, if it ever did — and only if it is still served. */
  async chosen(platform: BotPlatform, chatId: string): Promise<string | null> {
    const key = RedisKeys.botLang(platform, chatId);
    const lang = await this.redis.getJson<string>(key);
    if (!lang || !this.serves(lang)) return null;
    // Idle TTL, like the session: a chat that keeps talking keeps its choice.
    await this.redis.touch(key, this.ttl);
    return lang;
  }

  async choose(
    platform: BotPlatform,
    chatId: string,
    lang: string,
  ): Promise<boolean> {
    if (!this.serves(lang)) return false;
    await this.redis.setJson(RedisKeys.botLang(platform, chatId), lang, this.ttl);
    return true;
  }

  private serves(lang: string): boolean {
    const served = this.locale.languages();
    // Before the first snapshot lands there is nothing to check against, and
    // refusing every language would be worse than trusting the caller.
    return served.length === 0 || served.includes(lang);
  }
}
