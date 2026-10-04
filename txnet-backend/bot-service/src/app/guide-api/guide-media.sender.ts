import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { BotIntegration, TelegramLikeBotClient } from '@txnet-backend/messenger';
import { RedisKeys, RedisTtl } from '../redis/redis.keys';
import type { RedisService } from '../redis/redis.service';

/** A picture or a video of a guide, by object key, sent after its screen. */
export interface GuideMediaItem {
  kind: 'photo' | 'video';
  key: string;
  caption?: string;
}

/** A guide file's bytes and type, or `null` when they could not be had. */
export type GuideFileFetcher = (key: string) => Promise<{ bytes: Buffer; contentType: string } | null>;

/** The ceiling a bot may upload (Telegram's), the same as the guide video policy's (F-414-i). */
const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Guide files from `guide-media`'s in-network port (F-414-f, ADR-0118): the
 * store serves them to the bot as it serves videos to browsers, so no bytes go
 * through a Nest route. Unset `GUIDE_MEDIA_INTERNAL_URL` fetches nothing — the
 * guide's text still shows.
 */
export function guideFileFetcher(config: ConfigService): GuideFileFetcher {
  const base = (config.get<string>('GUIDE_MEDIA_INTERNAL_URL') ?? '').replace(/\/+$/, '');
  const logger = new Logger('GuideFileFetcher');
  return async (key) => {
    if (!base) return null;
    try {
      const response = await fetch(`${base}/${key.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(60_000) });
      const length = Number(response.headers.get('content-length') ?? 0);
      if (!response.ok || length > MAX_BYTES) {
        logger.warn(`guide file ${key}: ${response.status}, ${length} bytes`);
        return null;
      }
      return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
    } catch (e: unknown) {
      logger.warn(`guide file ${key} not fetched: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
}

/**
 * Sends a guide's pictures and video after its screen (F-414-f). A file goes
 * up once per bot: the platform's `file_id` is kept (`botGuideFile`) and sent
 * instead of the bytes next time — a key is never rewritten, so the id stays
 * true. A file that cannot be had or sent is skipped; the rest still go, and
 * the text has already said what the picture showed.
 */
export class GuideMediaSender {
  private readonly logger = new Logger(GuideMediaSender.name);

  constructor(
    private readonly redis: Pick<RedisService, 'get' | 'set'>,
    private readonly fetchFile: GuideFileFetcher,
  ) {}

  async send(client: Pick<TelegramLikeBotClient, 'sendMedia'>, integration: BotIntegration, chatId: string, items: readonly GuideMediaItem[]): Promise<void> {
    for (const item of items) {
      const cacheKey = RedisKeys.botGuideFile(integration, item.key);
      try {
        const known = await this.redis.get(cacheKey).catch((): null => null);
        if (known) {
          await client.sendMedia(chatId, item.kind, { fileId: known }, item.caption);
          continue;
        }
        const file = await this.fetchFile(item.key);
        if (!file) continue;
        const fileName = item.key.split('/').pop() ?? item.kind;
        const id = await client.sendMedia(chatId, item.kind, { fileName, contentType: file.contentType, bytes: file.bytes }, item.caption);
        if (id) await this.redis.set(cacheKey, id, RedisTtl.botGuideFile).catch((): undefined => undefined);
      } catch (e: unknown) {
        this.logger.warn(`guide ${item.kind} ${item.key} not sent to ${chatId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}
