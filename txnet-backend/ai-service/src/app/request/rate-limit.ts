import { RateLimit as SharedRateLimit, type RateLimitOptions } from '@txnet-backend/shared-core';

import type { RateLimitConfigKey } from '../config/env.validation';

/**
 * The shared `@RateLimit` (F-092-r), narrowed to this service's env schema: a
 * `configKey` the schema does not declare does not compile (F-087). Build the
 * bucket from the caller — `identityOf(req).userId` — never from anything two
 * users share.
 */
export const RateLimit = (options: RateLimitOptions<RateLimitConfigKey>) => SharedRateLimit(options);
