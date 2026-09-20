import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';

/**
 * The two budgets catalog management runs on (F-026-d, C-05), spelled once for
 * both of its surfaces: the ambient `/api/catalog` and the named reseller's
 * `/api/catalog/tenants/:tenantId/...` (F-066-w7).
 *
 * One bucket per caller across both, on purpose: it is the same person doing
 * the same work, and a second budget reached by putting a tenant id in the path
 * would be a way to spend twice as much of locale-service's time.
 */
export const CATALOG_ADMIN_READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.CATALOG_ADMIN_READ, identityOf(req).userId),
  configKey: 'CATALOG_ADMIN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};

export const CATALOG_ADMIN_WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.CATALOG_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'CATALOG_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};
