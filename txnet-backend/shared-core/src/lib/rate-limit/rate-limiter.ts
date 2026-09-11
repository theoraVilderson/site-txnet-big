import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { UnscopedRedisKeys, createScopedRedisKeys } from '../redis/keys';
import { TenantContext } from '../tenant-context/tenant-context';

/**
 * What the limiter needs of a Redis client, and nothing else (F-092-r).
 *
 * Each app owns its own `RedisService` — its own connection, its own keyspace
 * prefix from its own env — so the limiter cannot hold one. It takes this
 * instead, and every app's `RedisService` already satisfies it.
 */
export interface RateLimitStore {
  /** `INCR`, with the TTL attached atomically on the first hit of the window. */
  incrementWithTtl(key: string, ttlSec: number): Promise<number>;
  del(key: string): Promise<unknown>;
}

/** The DI token an app binds its `RedisService` to: `{ provide: RATE_LIMIT_STORE, useExisting: RedisService }`. */
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');

/**
 * The counter keys, scoped by the tenant in the request's context — the same
 * storage every app's own `TenantContext` narrows, so these are the keys
 * auth-service built before the move.
 */
const keys = createScopedRedisKeys({
  tenant: (what: string) => TenantContext.current(what).id,
  tenantOrNone: () => TenantContext.currentOrNull()?.id ?? 'none',
});

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
    @Inject(RATE_LIMIT_STORE) private readonly redis: RateLimitStore,
    private readonly config: ConfigService,
  ) {}

  async hit(
    bucket: string,
    limit: number,
    windowSec: number,
  ): Promise<RateLimitResult> {
    const current = await this.redis.incrementWithTtl(
      keys.rateLimit(bucket),
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
      UnscopedRedisKeys.rateLimitPlatform(bucket),
      windowSec,
    );
    return { allowed: current <= limit, current, limit };
  }

  async reset(bucket: string): Promise<void> {
    await this.redis.del(keys.rateLimit(bucket));
  }
}
