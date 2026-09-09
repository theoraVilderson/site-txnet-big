import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BotIntegration } from '@txnet-backend/messenger';
import { RedisService } from '../redis/redis.service';
import { RedisKeys, RedisTtl } from '../redis/redis.keys';
import { NavState } from './nav.types';

/** Redis-backed navigation state, TTL'd (ADR-0010). */
@Injectable()
export class ConversationStore {
  private readonly ttl: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.ttl = config.get<number>('BOT_NAV_TTL_SEC', RedisTtl.botNav);
  }

  get(integration: BotIntegration, chatId: string): Promise<NavState | null> {
    return this.redis.getJson<NavState>(RedisKeys.botNav(integration, chatId));
  }

  /**
   * A password is spent inside the request it arrives in and must never be
   * persisted — not for a step, not for a second. Stripping it here rather
   * than trusting every flow is the difference between a rule and a habit.
   */
  save(
    integration: BotIntegration,
    chatId: string,
    state: NavState,
  ): Promise<void> {
    const { password, newPassword, ...safe } = state.data ?? {};
    return this.redis.setJson(
      RedisKeys.botNav(integration, chatId),
      { ...state, data: safe },
      this.ttl,
    );
  }

  clear(integration: BotIntegration, chatId: string): Promise<void> {
    return this.redis.del(RedisKeys.botNav(integration, chatId));
  }
}
