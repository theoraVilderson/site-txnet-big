import { Controller, Get, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { CollectionHealthService } from './collection-health';

/**
 * The collection-health flag (F-027-w): `GET /api/billing/traffic/collection-health`.
 *
 * Whose service comes from the gate's `X-User-Id`, never from the query, so
 * there is no id here to authorise — the shape of the financial page and the
 * Grant list. It raises no domain error: a user with nothing metered is
 * `not_metered`, not a 404.
 *
 * The capability is `subscriptionLink`, as on the Grant list: this reads no
 * money, and it describes the service `/sub` hands out — so it is open exactly
 * when that service is.
 */
@Controller('billing/traffic')
export class CollectionHealthController {
  constructor(private readonly collection: CollectionHealthService) {}

  @TenantCapability('subscriptionLink')
  @Get('collection-health')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.TRAFFIC_COLLECTION_HEALTH, identityOf(req).userId),
    configKey: 'TRAFFIC_COLLECTION_HEALTH_RATE_LIMIT',
    windowSec: 900,
  })
  health(@Req() req: Request) {
    return this.collection.forUser(identityOf(req).userId);
  }
}
