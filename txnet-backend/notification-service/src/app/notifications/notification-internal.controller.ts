import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard } from '@txnet-backend/shared-core';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { CreateNotification, NotificationInboxService } from './notification-inbox.service';
import { createNotificationSchema } from './notification-inbox.schema';

/**
 * How another unit puts a row in a user's inbox (F-035-a): an Nx app cannot
 * import this one, so it asks over HTTP with `SERVICE_AUTH_TOKEN` (ADR-0011).
 * Not routed by Traefik; a wrong token is a 404.
 *
 * The body is typed as the service's input, not `z.infer`: with `strictNullChecks`
 * off zod infers every key optional, and the pipe is what guarantees them.
 *
 * No rate limit, for the reason `billing-service`'s internal seam gives: the
 * caller is a process, there is no user to bucket on, and a limit would drop
 * the platform's own notifications.
 */
@Controller('internal/notifications')
@UseGuards(ServiceOnlyGuard)
export class NotificationInternalController {
  constructor(private readonly inbox: NotificationInboxService) {}

  @Post()
  create(@Body(new ZodValidationPipe(createNotificationSchema)) body: CreateNotification) {
    return this.inbox.create(body);
  }
}
