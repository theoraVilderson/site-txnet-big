import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  RateLimitBucket,
  UnscopedRedisKeys,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';

import { BotPlatform } from './bot-platform';

/**
 * What the pacer needs of a Redis client, and nothing else — the same seam
 * `RateLimitStore` uses (F-092-r). `messenger` is a library imported by four
 * apps, each with its own connection and its own keyspace prefix, so it cannot
 * hold a client of its own. Every app's `RedisService` already satisfies this.
 */
export interface SendRateStore {
  /** `INCR`, with the TTL attached atomically on the first hit of the window. */
  incrementWithTtl(key: string, ttlSec: number): Promise<number>;
}

/** The DI token an app binds its `RedisService` to. Optional: see {@link BotSendPacer}. */
export const SEND_RATE_STORE = Symbol('SEND_RATE_STORE');

/** The window every ceiling below is counted over. */
export const SEND_RATE_WINDOW_SEC = 1;

/**
 * Messages per second one bot may send, per platform.
 *
 * Dated and sourced, for the reason `capabilities.ts` gives: a number with no
 * date and no source is not a ceiling, it is a guess that will be trusted.
 *
 * | platform | per second | where it comes from |
 * |---|---|---|
 * | telegram | 30 | Bot API "Broadcasting to users": ~30 messages/second to different users (verified 2026-09-20) |
 * | bale | 20 | **unconfirmed.** `docs.bale.ai` is not read yet, and Bale documents a `/business/` path with *higher* limits — so the real ceiling is per path, not per platform. Until someone reads it, Bale takes the lower number: being too slow costs a slower campaign, being too fast costs the tenant's bot. See `open-questions.md` |
 *
 * Both are overridable per deployment (`TELEGRAM_SEND_PER_SEC`,
 * `BALE_SEND_PER_SEC`), because the `/business/` path is proof that the number
 * belongs to a deployment rather than to this code.
 */
export const BOT_SEND_PER_SEC: Record<BotPlatform, number> = {
  telegram: 30,
  bale: 20,
};

/** The env var each platform's ceiling is read from. */
const CEILING_ENV: Record<BotPlatform, string> = {
  telegram: 'TELEGRAM_SEND_PER_SEC',
  bale: 'BALE_SEND_PER_SEC',
};

/**
 * One outbound budget per `(tenant x platform)` — per *bot*, which is what a
 * platform actually throttles and bans (ADR-0066, F-313-a).
 *
 * **Why this is not the inbound limiter.** `RateLimiter` counts what arrives
 * and rejects it, keyed on the tenant in the request's `TenantContext`. This
 * counts what *leaves*, on a worker that has no request and walks many tenants
 * in one run, so the tenant is an argument and the key is unscoped. The
 * counting is the same shape — one fixed window, `INCR` with a TTL — and the
 * bucket is declared in the same registry, so the platform's whole rate-limit
 * surface stays readable in one file (C-05).
 *
 * **Two ways to spend it, because there are two kinds of send** (F-313-c).
 * {@link take} is for a send that can wait — the bulk one — and over budget it
 * answers with seconds to wait, in the shape a platform's own 429 carries, so
 * no call site had to learn anything new. {@link spend} is for a send a person
 * is waiting on, which counts and goes regardless. Both hit the same counter,
 * and that is what makes the bulk sender's budget true: the one caller that
 * *can* yield is the one that does.
 *
 * **Unbound is unpaced.** With no store the pacer lets everything through, as
 * before it existed. Every app that sends binds one today; an app that forgets
 * loses its counting, not its sends.
 */
@Injectable()
export class BotSendPacer {
  private readonly logger = new Logger(BotSendPacer.name);

  constructor(
    @Optional() @Inject(SEND_RATE_STORE) private readonly store: SendRateStore | null,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /**
   * Spend one of this bot's budget.
   *
   * `null` means send now. A number is how many seconds to wait before this
   * bot sends again — never `null` in that case, because a caller reading
   * "no wait given" as "go ahead" is the one mistake this API can invite.
   */
  async take(tenantId: string, platform: BotPlatform): Promise<number | null> {
    const limit = this.ceilingOf(platform);
    if (limit <= 0) return null;

    const current = await this.count(tenantId, platform);
    if (current === null) return null;
    return current <= limit ? null : SEND_RATE_WINDOW_SEC;
  }

  /**
   * Spend one of this bot's budget for a send that **cannot** be deferred
   * (F-313-c).
   *
   * `sendMessage` and `sendInvoice` are answers to a person who is waiting,
   * and `sendMessage` throws on failure — so refusing one would turn a spent
   * budget into a failed login or a screen that never arrives. They count and
   * go anyway.
   *
   * Counting them is the point, not a formality: a ceiling only means anything
   * if everyone spends from it. Without this, a campaign would pace itself
   * against a budget that interactive traffic was quietly draining, and the
   * two would race each other into the ban the pacer exists to avoid. With it,
   * the bulk sender is the one that yields — which is the right way round,
   * since it is the only one that can wait.
   */
  async spend(tenantId: string, platform: BotPlatform): Promise<void> {
    if (this.ceilingOf(platform) <= 0) return;
    await this.count(tenantId, platform);
  }

  /**
   * One hit on this bot's counter, or `null` when there is nothing to count
   * in — no store bound, or a Redis that did not answer.
   *
   * **Fail open, deliberately.** A counter that cannot be reached is a reason
   * to stop counting, not a reason to stop sending: the alternative is a Redis
   * outage that silently takes every tenant's OTP delivery down with it. The
   * cost is that sends during an outage are unpaced, which is what they were
   * before this existed.
   */
  private async count(tenantId: string, platform: BotPlatform): Promise<number | null> {
    if (!this.store) return null;

    const key = UnscopedRedisKeys.outboundRate(
      rateLimitBucketKey(RateLimitBucket.BOT_SEND, `${tenantId}:${platform}`),
    );
    try {
      return await this.store.incrementWithTtl(key, SEND_RATE_WINDOW_SEC);
    } catch (err) {
      this.logger.warn(
        `send budget for ${tenantId} on ${platform} not counted, sending unpaced: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /** The deployment's ceiling for a platform, else the documented default. */
  private ceilingOf(platform: BotPlatform): number {
    const fallback = BOT_SEND_PER_SEC[platform];
    return this.config?.get<number>(CEILING_ENV[platform], fallback) ?? fallback;
  }
}
