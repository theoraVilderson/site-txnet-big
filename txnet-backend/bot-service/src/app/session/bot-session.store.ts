import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotPlatform } from '@txnet-backend/messenger';
import { RedisService } from '../redis/redis.service';
import { RedisKeys, RedisTtl } from '../redis/redis.keys';

/**
 * A signed-in chat.
 *
 * The bot invents no identity model: it holds the ordinary `auth-api` refresh
 * token, exactly as the panel's browser holds it in a cookie, and this Redis
 * entry is the cookie's equivalent (ADR-0011). A chat id on its own is never
 * an authentication — without an entry here the chat is signed out, however
 * well-known its owner is.
 */
export interface BotSession {
  refreshToken: string;
  signedInAt: number;
}

@Injectable()
export class BotSessionStore {
  private readonly ttl: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttl = config.get<number>('BOT_SESSION_TTL_SEC', RedisTtl.botSession);
  }

  async get(platform: BotPlatform, chatId: string): Promise<BotSession | null> {
    const key = RedisKeys.botSession(platform, chatId);
    const session = await this.redis.getJson<BotSession>(key);
    // Idle TTL: every message the chat sends pushes the expiry out again.
    if (session) await this.redis.touch(key, this.ttl);
    return session;
  }

  save(
    platform: BotPlatform,
    chatId: string,
    refreshToken: string,
  ): Promise<void> {
    return this.redis.setJson(
      RedisKeys.botSession(platform, chatId),
      { refreshToken, signedInAt: Date.now() } satisfies BotSession,
      this.ttl,
    );
  }

  clear(platform: BotPlatform, chatId: string): Promise<void> {
    return this.redis.del(RedisKeys.botSession(platform, chatId));
  }
}
