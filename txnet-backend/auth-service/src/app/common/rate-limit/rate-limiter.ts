import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys } from '../../redis/redis.keys';

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
}

/** What `PLATFORM_RATE_LIMIT_FACTOR` is when an environment sets nothing. */
const DEFAULT_PLATFORM_FACTOR = 10;

/**
 * Fixed-window rate limiting over Redis: one counter per bucket, TTL attached
 * atomically on the first hit of each window. Used both by the global
 * {@link RateLimitGuard} and by identity-scoped locks (e.g. failed logins).
 */
@Injectable()
export class RateLimiter {
  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  async hit(
    bucket: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitResult> {
    const current = await this.redis.incrementWithTtl(
      RedisKeys.rateLimit(bucket),
      windowSec,
    );
    return { allowed: current <= limit, current, limit };
  }

  /**
   * The same bucket counted once for the whole platform (F-066-s).
   *
   * `hit` keys on the request's tenant, which the caller picks by picking a
   * hostname: N tenants is N budgets for one IP. This counter has no tenant in
   * it, so those N collapse into one, and its ceiling is
   * `PLATFORM_RATE_LIMIT_FACTOR` times the route's own limit — one number for
   * the whole platform, and a route that raises its limit raises its ceiling
   * with it. A factor of `0` switches the ceiling off and writes no key.
   *
   * Call it only for a bucket built from the **caller** — an IP, a bot chat
   * id. A bucket naming the account under attack (`login-failures:<identity>`)
   * must never be counted platform-wide: it would lock every reseller's
   * `admin` out because one reseller's was guessed at, which is exactly what
   * F-066-o closed.
   */
  async hitPlatform(
    bucket: string,
    tenantLimit: number,
    windowSec: number,
  ): Promise<RateLimitResult> {
    const factor = this.config.get<number>(
      'PLATFORM_RATE_LIMIT_FACTOR',
      DEFAULT_PLATFORM_FACTOR,
    );
    const limit = tenantLimit * factor;
    if (factor <= 0) return { allowed: true, current: 0, limit };

    const current = await this.redis.incrementWithTtl(
      RedisKeys.rateLimitPlatform(bucket),
      windowSec,
    );
    return { allowed: current <= limit, current, limit };
  }

  reset(bucket: string): Promise<void> {
    return this.redis.del(RedisKeys.rateLimit(bucket));
  }
}
