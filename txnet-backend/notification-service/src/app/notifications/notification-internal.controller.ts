import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard } from '@txnet-backend/shared-core';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { CreateNotification, NotificationInboxService } from './notification-inbox.service';
import { createNotificationSchema } from './notification-inbox.schema';
import { RetentionClaim, RetentionLedgerService } from './retention-ledger.service';
import { retentionClaimSchema } from './retention-ledger.schema';

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
 *
 * `retention/claim` is the retention ledger (F-601-a): worker-service asks it
 * before telling a retention notice, so each is told once per Grant period.
 */
@Controller('internal/notifications')
@UseGuards(ServiceOnlyGuard)
export class NotificationInternalController {
  constructor(
    private readonly inbox: NotificationInboxService,
    private readonly retention: RetentionLedgerService,
  ) {}

  @Post()
  create(@Body(new ZodValidationPipe(createNotificationSchema)) body: CreateNotification) {
    return this.inbox.create(body);
  }

  @Post('retention/claim')
  @HttpCode(200)
  claimRetention(@Body(new ZodValidationPipe(retentionClaimSchema)) body: RetentionClaim) {
    return this.retention.claim(body);
  }
}
