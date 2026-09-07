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
 * 2026-09-06; ADR-0016):
 *
 * 1. **what the user chose** in the bot, kept in Redis and re-armed on every
 *    message;
 * 2. **the bot's own default** (`BOT_DEFAULT_LANGUAGE`), for a deployment
 *    whose bot speaks a different language from the rest of the platform;
 * 3. **the deployment's language** (`DEFAULT_LANGUAGE`) — a tenant sells in a
 *    language, and that outranks a phone setting. It is always set, so in
 *    practice this is the step that answers a first-time chat;
 * 4. **the messenger's hint**, which is only reached when neither configured
 *    default is a language `locale-service` actually serves.
 *
 * A configured default that locale-service does not serve is a misconfiguration
 * worth a warning, not a dead end: it is skipped and the next step answers.
 */
@Injectable()
export class ChatLanguage {
  private readonly logger = new Logger(ChatLanguage.name);
  private readonly ttl: number;
  /** `[env var, value]` for each configured default, in precedence order. */
  private readonly defaults: [string, string][];

  constructor(
    private readonly redis: RedisService,
    private readonly locale: LocaleService,
    config: ConfigService,
  ) {
    this.ttl = config.get<number>('BOT_LANG_TTL_SEC', RedisTtl.botLang);
    this.defaults = (
      [
        ['BOT_DEFAULT_LANGUAGE', config.get<string>('BOT_DEFAULT_LANGUAGE')],
        ['DEFAULT_LANGUAGE', config.get<string>('DEFAULT_LANGUAGE')],
      ] as [string, string | undefined][]
    ).filter((pair): pair is [string, string] => Boolean(pair[1]));
  }

  /**
   * The language for this message. `hint` is what the normalizer resolved out
   * of the update — it answers only when this deployment has configured no
   * language locale-service can serve.
   */
  async resolve(
    platform: BotPlatform,
    chatId: string,
    hint: string,
  ): Promise<string> {
    const chosen = await this.chosen(platform, chatId);
    if (chosen) return chosen;
    for (const [name, lang] of this.defaults) {
      if (this.serves(lang)) return lang;
      this.logger.warn(
        `${name}=${lang} is not served by locale-service — falling through to the next default`,
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
