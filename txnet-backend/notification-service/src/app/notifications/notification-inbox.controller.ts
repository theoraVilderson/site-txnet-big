import { Body, Controller, Get, HttpCode, Post, Query, Req } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { NotificationInboxService } from './notification-inbox.service';
import { InboxQuery, MarkReadBody, inboxQuerySchema, markReadSchema } from './notification-inbox.schema';

/**
 * The caller's own inbox (F-035-a), behind the gate like every route here
 * (`app.module.ts`). Whose inbox comes from `X-User-Id`, never from the request,
 * so there is no id to authorise and no route that names another user.
 */
@Controller('notifications')
export class NotificationInboxController {
  constructor(private readonly inbox: NotificationInboxService) {}

  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.NOTIFICATION_READ, identityOf(req).userId),
    configKey: 'NOTIFICATION_READ_RATE_LIMIT',
    windowSec: 900,
  })
  list(@Query(new ZodValidationPipe(inboxQuerySchema)) query: InboxQuery, @Req() req: Request) {
    return this.inbox.page({ userId: identityOf(req).userId, ...query });
  }

  @Post('read')
  @HttpCode(200)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.NOTIFICATION_WRITE, identityOf(req).userId),
    configKey: 'NOTIFICATION_WRITE_RATE_LIMIT',
    windowSec: 900,
  })
  markRead(@Body(new ZodValidationPipe(markReadSchema)) body: MarkReadBody, @Req() req: Request) {
    return this.inbox.markRead({ userId: identityOf(req).userId, ids: body.ids });
  }
}
