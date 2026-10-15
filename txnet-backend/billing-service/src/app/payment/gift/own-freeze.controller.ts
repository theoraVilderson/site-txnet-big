import { Controller, HttpCode, HttpStatus, Ip, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { OwnFreezeService } from './own-freeze.service';

/** The buyer's writes on their own service share one budget, as naming one does (F-307-x). */
const ownActionLimit = RateLimit({
  key: (req: Request) => rateLimitBucketKey(RateLimitBucket.CONFIG_ACTION, identityOf(req).userId),
  configKey: 'CONFIG_ACTION_RATE_LIMIT',
  windowSec: 900,
});

/**
 * The user freezes and unfreezes their own Grant (F-0401-c):
 * `POST /api/billing/gift/grants/:grantId/freeze` and `…/unfreeze`, no body.
 * The user is the gate's `X-User-Id`; another user's Grant is the same 404 as
 * a missing one. `subscriptionLink`, as the list these rows come from.
 */
@Controller('billing/gift/grants')
export class OwnFreezeController {
  constructor(private readonly freezes: OwnFreezeService) {}

  @TenantCapability('subscriptionLink')
  @Post(':grantId/freeze')
  @HttpCode(HttpStatus.OK)
  @ownActionLimit
  freeze(@Param('grantId', ParseUUIDPipe) grantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.freezes.freeze({ userId: identityOf(req).userId, ip }, grantId);
  }

  @TenantCapability('subscriptionLink')
  @Post(':grantId/unfreeze')
  @HttpCode(HttpStatus.OK)
  @ownActionLimit
  unfreeze(@Param('grantId', ParseUUIDPipe) grantId: string, @Req() req: Request, @Ip() ip: string) {
    return this.freezes.unfreeze({ userId: identityOf(req).userId, ip }, grantId);
  }
}
