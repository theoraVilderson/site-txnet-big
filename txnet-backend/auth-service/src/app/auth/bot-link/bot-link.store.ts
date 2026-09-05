import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys, RedisTtl } from '../../redis/redis.keys';
import { BotPlatform } from '../otp/senders/bot-client.registry';
import { PendingBotLink } from './bot-link.types';

/**
 * Owns the pending-link keyspace: the token record, the (platform, phone)
 * pointer that makes a repeated request idempotent, and the chat pointer that
 * carries the token from `/start` to the contact message that follows it.
 */
@Injectable()
export class BotLinkStore {
  private readonly ttl: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttl = config.get<number>('BOT_LINK_TOKEN_TTL_SEC', RedisTtl.botLink);
  }

  get ttlSeconds(): number {
    return this.ttl;
  }

  async save(link: PendingBotLink): Promise<void> {
    await this.redis.setJson(
      RedisKeys.botLinkToken(link.token),
      link,
      this.ttl,
    );
    await this.redis.set(
      RedisKeys.botLinkPhone(link.platform, link.phoneNumber),
      link.token,
      this.ttl,
    );
  }

  /** Overwrites the record in place, keeping the remaining TTL out of scope. */
  async update(link: PendingBotLink): Promise<void> {
    await this.redis.setJson(
      RedisKeys.botLinkToken(link.token),
      link,
      this.ttl,
    );
  }

  byToken(token: string): Promise<PendingBotLink | null> {
    return this.redis.getJson<PendingBotLink>(RedisKeys.botLinkToken(token));
  }

  /** The still-live token for this (platform, phone), if any. */
  async byPhone(
    platform: BotPlatform,
    phoneNumber: string,
  ): Promise<PendingBotLink | null> {
    const token = await this.redis.get(
      RedisKeys.botLinkPhone(platform, phoneNumber),
    );
    return token ? this.byToken(token) : null;
  }

  /** Remembers which link the chat is answering, for its next message. */
  async bindChat(
    platform: BotPlatform,
    chatId: string,
    token: string,
  ): Promise<void> {
    await this.redis.set(
      RedisKeys.botLinkChat(platform, chatId),
      token,
      this.ttl,
    );
  }

  async byChat(
    platform: BotPlatform,
    chatId: string,
  ): Promise<PendingBotLink | null> {
    const token = await this.redis.get(RedisKeys.botLinkChat(platform, chatId));
    return token ? this.byToken(token) : null;
  }

  async releaseChat(platform: BotPlatform, chatId: string): Promise<void> {
    await this.redis.del(RedisKeys.botLinkChat(platform, chatId));
  }

  /**
   * Remembers a chat that proved it owns `phoneNumber` while no account for
   * that number exists yet (registration in flight). Kept as long as the
   * pending registration itself, so the two expire together.
   */
  async saveProvenChat(
    platform: BotPlatform,
    phoneNumber: string,
    chatId: string,
  ): Promise<void> {
    await this.redis.set(
      RedisKeys.botLinkProvenChat(platform, phoneNumber),
      chatId,
      RedisTtl.registerPending,
    );
  }

  provenChat(
    platform: BotPlatform,
    phoneNumber: string,
  ): Promise<string | null> {
    return this.redis.get(RedisKeys.botLinkProvenChat(platform, phoneNumber));
  }

  async clearProvenChat(
    platform: BotPlatform,
    phoneNumber: string,
  ): Promise<void> {
    await this.redis.del(RedisKeys.botLinkProvenChat(platform, phoneNumber));
  }
}
