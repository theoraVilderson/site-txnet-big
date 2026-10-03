import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';

import { AUDIENCE_PAGE_MAX, LotteryAudiencePage, LotteryAudienceService } from './lottery-audience.service';
import { LotteryCloseService } from './lottery-close.service';
import { LotteryDeliveryService } from './lottery-delivery.service';
import { LotteryDrawService } from './lottery-draw.service';

/** `scanned`/`frozen` are the close's; `drawn` the draw's; `delivered` the delivery's; `failed` all three. */
export type CloseDueAnswer = { scanned: number; frozen: number; drawn: number; delivered: number; failed: number };

/**
 * The seam `worker-service`'s `lottery_close` tick reaches the freeze through
 * (F-707-k). The rule is engagement's; the clock is the worker's, as for
 * `deliver-due` (`entitlement-internal.controller.ts`, which explains the
 * seam: outside the edge router and the identity middleware,
 * `ServiceOnlyGuard` refusing anyone else as a neutral 404).
 *
 * This is the only way a lottery is frozen, its seed made and its draw run:
 * no admin route starts, repeats or seeds either (ADR-0111 point 5). The draw
 * (F-707-l) runs right after the freezes, and the delivery (F-707-m) right
 * after the draws; each also takes what a failed run left behind.
 */
@TenantCapability('system')
@Controller('internal/billing/engagement/lotteries')
@UseGuards(ServiceOnlyGuard)
export class LotteryInternalController {
  constructor(
    private readonly close: LotteryCloseService,
    private readonly draw: LotteryDrawService,
    private readonly delivery: LotteryDeliveryService,
    private readonly audience: LotteryAudienceService,
  ) {}

  /**
   * Every published lottery past its close time, frozen once; then every
   * frozen one drawn once; then every drawn one's pending prizes given. Safe
   * to run twice: each step takes a lottery under its row lock, only in the
   * status it moves on from, and a prize is given once per place.
   */
  @Post('close-due')
  @HttpCode(200)
  async closeDue(): Promise<CloseDueAnswer> {
    const closed = await this.close.closeDue();
    const drawn = await this.draw.drawDue();
    const given = await this.delivery.deliverDue();
    return { scanned: closed.scanned, frozen: closed.frozen, drawn: drawn.drawn, delivered: given.delivered, failed: closed.failed + drawn.failed + given.failed };
  }

  /**
   * F-707-q: a page of who a published lottery's announcement goes to —
   * worker-service's fan-out of `engagement.lottery.published`. Empty and
   * `open: false` once it is cancelled, closed or gone.
   */
  @Get(':id/audience')
  async audienceOf(@Param('id', new ParseUUIDPipe()) id: string, @Query('after') after?: string, @Query('limit') limit?: string): Promise<LotteryAudiencePage> {
    const cursor = after && /^[0-9a-f-]{36}$/i.test(after) ? after : null;
    return this.audience.page(id, cursor, Number(limit) || AUDIENCE_PAGE_MAX);
  }
}
