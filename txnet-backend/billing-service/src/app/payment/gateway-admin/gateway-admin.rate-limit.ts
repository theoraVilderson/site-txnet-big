import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';

/**
 * The two budgets gateway management runs on (F-092-r, C-05), spelled once for
 * both of its surfaces: the ambient `/api/billing/gateways` and the named
 * reseller's `/api/billing/tenants/:tenantId/gateways` (F-066-w3).
 *
 * One bucket per caller across both, on purpose: it is the same person doing
 * the same work, and a second budget reached by putting a tenant id in the path
 * would be a way to spend twice as much of the vault writer's time.
 */
export const GATEWAY_ADMIN_READ = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.GATEWAY_ADMIN_READ, identityOf(req).userId),
  configKey: 'GATEWAY_ADMIN_READ_RATE_LIMIT' as const,
  windowSec: 900,
};

export const GATEWAY_ADMIN_WRITE = {
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.GATEWAY_ADMIN_WRITE, identityOf(req).userId),
  configKey: 'GATEWAY_ADMIN_WRITE_RATE_LIMIT' as const,
  windowSec: 900,
};
