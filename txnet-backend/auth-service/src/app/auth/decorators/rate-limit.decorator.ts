import { SetMetadata } from '@nestjs/common';

import type { RateLimitConfigKey } from '../../config/env.validation';

export const RATE_LIMIT_KEY = 'rate_limit';

export interface RateLimitOptions {
  key: (req: any) => string;
  /**
   * The env variable holding this route's limit. **Required** (F-087, decided
   * 2026-09-11): every limit is deployment config, so tightening one under
   * attack is an env change and a restart, not a rebuild.
   *
   * There is deliberately no `limit` beside it. The default lives once, in the
   * env schema; a second number here would be a default the schema's could
   * silently disagree with. Typed as `RateLimitConfigKey` so a misspelled name
   * does not compile — the silent fall-back a free-form string would allow is
   * the one real cost of making every limit tunable.
   *
   * Decorator metadata is evaluated once, when the class is defined, so a route
   * cannot read `ConfigService` here — it names the variable and
   * `RateLimitGuard` resolves it per request.
   */
  configKey: RateLimitConfigKey;
  /** The window the limit counts over. Stays on the route by contract. */
  windowSec: number;
}

export const RateLimit = (options: RateLimitOptions) =>
  SetMetadata(RATE_LIMIT_KEY, options);
