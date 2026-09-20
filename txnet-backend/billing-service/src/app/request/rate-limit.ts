import { RateLimit as SharedRateLimit, type RateLimitOptions } from '@txnet-backend/shared-core';

import type { RateLimitConfigKey } from '../config/env.validation';

/**
 * The shared `@RateLimit` (F-092-r), narrowed to this service's env schema: a
 * `configKey` the schema does not declare does not compile (F-087). Build the
 * bucket from the caller — `identityOf(req).userId` — never from anything two
 * users share.
 *
 * The gateway callback is the one exception, and it is not a loophole: it is
 * public, so there is no caller to build a bucket from, and it counts the
 * payment instead (F-092-j, F-104-u). `rate-limit-coverage.spec.ts` holds the
 * list of controllers allowed to do that, and it has one entry.
 */
export const RateLimit = (options: RateLimitOptions<RateLimitConfigKey>) => SharedRateLimit(options);
