import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotClientRegistry, BotIntegration, escapeHtml } from '@txnet-backend/messenger';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';
import { ChatLanguage } from '../locale/chat-language';
import { RedisKeys, RedisTtl } from '../redis/redis.keys';
import { RedisService } from '../redis/redis.service';

/** The part of a queued update the stale notice needs. */
export interface StaleUpdate {
  integration: BotIntegration;
  chatId: string;
  lang: string;
  callbackQueryId?: string;
}

/**
 * Hosting H19: an update that waited in the queue longer than
 * `BOT_UPDATE_STALE_MS` is not run. After an outage the backlog is taps and
 * messages the user has given up on, and running them sends a burst of
 * screens in an order nobody remembers. The chat is told once instead.
 */
@Injectable()
export class StaleUpdateNotice {
  private readonly logger = new Logger(StaleUpdateNotice.name);
  private readonly staleMs: number;

  constructor(
    private readonly bots: BotClientRegistry,
    private readonly redis: RedisService,
    private readonly copy: BotCopy,
    private readonly langs: ChatLanguage,
    config: ConfigService,
  ) {
    this.staleMs = config.getOrThrow<number>('BOT_UPDATE_STALE_MS');
  }

  /** No `receivedAt` is a message published before the field existed: fresh. */
  isStale(receivedAt: string | undefined, now = Date.now()): boolean {
    if (!receivedAt) return false;
    const at = Date.parse(receivedAt);
    return Number.isFinite(at) && now - at > this.staleMs;
  }

  /**
   * A tap is answered on its button. A message, or a tap whose query the
   * platform has already expired, gets a reply — once per chat per window, so
   * a backlog of twenty messages is not twenty replies.
   */
  async tell(update: StaleUpdate): Promise<void> {
    const client = await this.bots.client(update.integration, 'bot-app:StaleUpdateNotice');
    if (!client) return;
    const lang = await this.langs.resolve(update.integration, update.chatId, update.lang);
    const text = this.copy.text(lang, { key: BotKeys.common.staleUpdate });

    if (update.callbackQueryId) {
      try {
        await client.answerCallbackQuery(update.callbackQueryId, text);
        return;
      } catch (err) {
        this.logger.warn(
          `stale tap in ${update.integration.id}/${update.chatId} not answered, replying instead: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const first = await this.redis.setIfAbsent(
      RedisKeys.botStaleNotice(update.integration, update.chatId),
      '1',
      RedisTtl.botStaleNotice,
    );
    if (first) await client.sendMessage(update.chatId, escapeHtml(text));
  }
}
