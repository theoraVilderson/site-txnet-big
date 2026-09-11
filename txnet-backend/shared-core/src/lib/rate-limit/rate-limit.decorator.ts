import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'rate_limit';

export interface RateLimitOptions<ConfigKey extends string = string> {
  key: (req: any) => string;
  /**
   * The env variable holding this route's limit. **Required** (F-087, decided
   * 2026-09-11): every limit is deployment config, so tightening one under
   * attack is an env change and a restart, not a rebuild.
   *
   * There is deliberately no `limit` beside it. The default lives once, in the
   * env schema; a second number here would be a default the schema's could
   * silently disagree with. Typed as the app's `RateLimitConfigKey` so a misspelled name
   * does not compile — the silent fall-back a free-form string would allow is
   * the one real cost of making every limit tunable.
   *
   * Decorator metadata is evaluated once, when the class is defined, so a route
   * cannot read `ConfigService` here — it names the variable and
   * `RateLimitGuard` resolves it per request.
   */
  configKey: ConfigKey;
  /** The window the limit counts over. Stays on the route by contract. */
  windowSec: number;
}

/**
 * Generic over the config key, because the env schema is each app's: an app
 * narrows it once to its own `RateLimitConfigKey` —
 * `(o: RateLimitOptions<RateLimitConfigKey>) => RateLimit(o)` — so a
 * misspelled variable is still a compile error there (F-087).
 */
export const RateLimit = <ConfigKey extends string>(options: RateLimitOptions<ConfigKey>) =>
  SetMetadata(RATE_LIMIT_KEY, options);
