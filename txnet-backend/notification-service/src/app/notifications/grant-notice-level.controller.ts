import { Body, Controller, Get, Param, Put, Req } from '@nestjs/common';
import { RateLimitBucket, TenantCapability, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { GrantNoticeLevelService } from './grant-notice-level.service';
import { grantIdSchema, grantNoticeLevelSchema, type GrantNoticeLevel } from './grant-notice-level.schema';

/**
 * The caller's notice level per service (F-601-o): which of their Grants are
 * told essentials only. Whose it is comes from `X-User-Id` (invariant 15);
 * the inbox's buckets, as the rest of the preferences.
 */
@Controller('notifications/preferences/grants')
export class GrantNoticeLevelController {
  constructor(private readonly levels: GrantNoticeLevelService) {}

  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.NOTIFICATION_READ, identityOf(req).userId),
    configKey: 'NOTIFICATION_READ_RATE_LIMIT',
    windowSec: 900,
  })
  list(@Req() req: Request) {
    return this.levels.list(identityOf(req).userId);
  }

  @Put(':grantId')
  // The user's own account, not the reseller's panel: open while suspended (F-018-p).
  @TenantCapability('account')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.NOTIFICATION_WRITE, identityOf(req).userId),
    configKey: 'NOTIFICATION_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  set(
    @Param('grantId', new ZodValidationPipe(grantIdSchema)) grantId: string,
    @Body(new ZodValidationPipe(grantNoticeLevelSchema)) body: { level: GrantNoticeLevel },
    @Req() req: Request,
  ) {
    return this.levels.set(identityOf(req).userId, grantId, body.level);
  }
}
