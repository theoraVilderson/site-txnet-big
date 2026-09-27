import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import { RateLimitBucket, TenantCapability, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { NotificationPreferencesService, Preferences } from './notification-preferences.service';
import { preferencesSchema } from './notification-preferences.schema';

/**
 * The caller's own retention notice preferences (F-601-m, spec 9.4): which
 * kinds are muted, and quiet hours in their zone. Whose they are comes from
 * `X-User-Id`, as the inbox's does (invariant 15); the inbox's buckets.
 */
@Controller('notifications/preferences')
export class NotificationPreferencesController {
  constructor(private readonly preferences: NotificationPreferencesService) {}

  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.NOTIFICATION_READ, identityOf(req).userId),
    configKey: 'NOTIFICATION_READ_RATE_LIMIT',
    windowSec: 900,
  })
  get(@Req() req: Request) {
    return this.preferences.get(identityOf(req).userId);
  }

  @Put()
  // The user's own account, not the reseller's panel: open while suspended (F-018-p).
  @TenantCapability('account')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.NOTIFICATION_WRITE, identityOf(req).userId),
    configKey: 'NOTIFICATION_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  set(@Body(new ZodValidationPipe(preferencesSchema)) body: Preferences, @Req() req: Request) {
    return this.preferences.set(identityOf(req).userId, body);
  }
}
