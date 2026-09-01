import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys } from '../../redis/redis.keys';

export interface RateLimitResult {
  allowed: boolean;
  current: number;
  limit: number;
}

/**
 * Fixed-window rate limiting over Redis: one counter per bucket, TTL attached
 * atomically on the first hit of each window. Used both by the global
 * {@link RateLimitGuard} and by identity-scoped locks (e.g. failed logins).
 */
@Injectable()
export class RateLimiter {
  constructor(private readonly redis: RedisService) {}

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

  reset(bucket: string): Promise<void> {
    return this.redis.del(RedisKeys.rateLimit(bucket));
  }
}
