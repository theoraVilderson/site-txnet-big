import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { CloseDueResult, LotteryCloseService } from './lottery-close.service';

/**
 * The seam `worker-service`'s `lottery_close` tick reaches the freeze through
 * (F-707-k). The rule is engagement's; the clock is the worker's, as for
 * `deliver-due` (`entitlement-internal.controller.ts`, which explains the
 * seam: outside the edge router and the identity middleware,
 * `ServiceOnlyGuard` refusing anyone else as a neutral 404).
 *
 * This is the only way a lottery is frozen and its seed made: no admin route
 * starts, repeats or seeds it (ADR-0111 point 5).
 */
@TenantCapability('system')
@Controller('internal/billing/engagement/lotteries')
@UseGuards(ServiceOnlyGuard)
export class LotteryInternalController {
  constructor(private readonly close: LotteryCloseService) {}

  /** Every published lottery past its close time, frozen once. Safe to run twice: each is taken under its row lock while `published`. */
  @Post('close-due')
  @HttpCode(200)
  closeDue(): Promise<CloseDueResult> {
    return this.close.closeDue();
  }
}
