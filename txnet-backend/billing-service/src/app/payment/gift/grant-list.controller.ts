import { Controller, Get, Query, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { GrantService } from '../../entitlement/grant';
import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GrantListQuery, grantListSchema } from './grant-list.schema';

/**
 * A user's own Grants, listed (F-502-r): `GET /api/billing/gift/grants`.
 *
 * It lives beside the reissue route because it is what makes that route
 * reachable. A `free_grant` key is shown once and only hashed (D-35), and until
 * this list existed the reissue button (F-502-q) was reachable only while the
 * key was still on screen — a key lost after the modal closed had no way back.
 *
 * **Whose Grants comes from the gate's `X-User-Id`**, never from the query, so
 * there is no id here to authorise — the same shape as the financial page
 * (`wallet/wallet-history.controller.ts`). It raises no domain error either: a
 * user with no Grants is an empty page, not a 404. The only failures are a
 * malformed query (400, from the pipe) and the limiter (429).
 *
 * The capability is `subscriptionLink`, as on the reissue route: this reads no
 * money and what it lists are the `/sub` credentials' Grants, so it is open
 * exactly when `/sub` is — a suspended tenant's user still finds their services
 * until the grace ends.
 */
@Controller('billing/gift/grants')
export class GrantListController {
  constructor(private readonly grants: GrantService) {}

  @TenantCapability('subscriptionLink')
  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.GRANT_LIST, identityOf(req).userId),
    configKey: 'GRANT_LIST_RATE_LIMIT',
    windowSec: 900,
  })
  list(@Query(new ZodValidationPipe(grantListSchema)) query: GrantListQuery, @Req() req: Request) {
    return this.grants.listForUser(identityOf(req).userId, query);
  }
}
