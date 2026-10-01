import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, type QuotaDigestRun } from '@txnet-backend/shared-core';

import { QuotaDigestService } from './quota-digest.service';

/**
 * `POST /api/internal/notifications/reseller-quota/digest` (F-019-v8):
 * worker-service's hourly job. Safe to call any time — before 09:00 on the
 * quota clock it tells nothing, after it each reseller once a day. No body,
 * no rate limit: the caller is a process (`notification-internal.controller.ts`).
 */
@Controller('internal/notifications/reseller-quota')
@UseGuards(ServiceOnlyGuard)
export class QuotaInternalController {
  constructor(private readonly digests: QuotaDigestService) {}

  @Post('digest')
  @HttpCode(200)
  digest(): Promise<QuotaDigestRun> {
    return this.digests.run();
  }
}
