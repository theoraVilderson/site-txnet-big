import {
  RATE_LIMIT_KEY,
  RateLimit as SharedRateLimit,
  type RateLimitOptions as SharedRateLimitOptions,
} from '@txnet-backend/shared-core';

import type { RateLimitConfigKey } from '../../config/env.validation';

/**
 * The shared `@RateLimit` (in `shared-core` since F-092-r), narrowed to this
 * service's env schema: a `configKey` this schema does not declare does not
 * compile (F-087).
 */
export { RATE_LIMIT_KEY };
export type RateLimitOptions = SharedRateLimitOptions<RateLimitConfigKey>;
export const RateLimit = (options: RateLimitOptions) => SharedRateLimit(options);
