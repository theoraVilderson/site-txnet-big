import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate_limit';

export interface RateLimitOptions {
  key: (req: any) => string;
  /** The limit when nothing configures one. */
  limit: number;
  windowSec: number;
  /**
   * Env var that overrides `limit` for this route.
   *
   * Decorator metadata is evaluated once, when the class is defined, so a
   * route cannot read `ConfigService` here — it names the variable instead and
   * `RateLimitGuard` resolves it per request. `limit` stays as the default,
   * which is what an environment that sets nothing gets.
   */
  configKey?: string;
}

export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
