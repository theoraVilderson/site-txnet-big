import { Body, Controller, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { BackendI18nKeys, ServiceOnlyGuard } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { CampaignDeliveryService } from './campaign-delivery.service';
import { CampaignFanOutRefused, CampaignFanOutService, RECIPIENT_OUTCOMES, RecipientOutcome } from './campaign-fan-out.service';

const outcomeSchema = z
  .object({ outcome: z.enum(RECIPIENT_OUTCOMES, { message: BackendI18nKeys.errors.validation.failed }) })
  .strict(BackendI18nKeys.errors.validation.failed);

/**
 * Sending campaigns (F-035-d), for processes only (`SERVICE_AUTH_TOKEN`, ADR-0011):
 * `worker-service`'s fan-out and delivery jobs, and the adapters (F-035-e/f). Not
 * routed by Traefik; a wrong token is a 404. No rate limit, for the reason
 * `notification-internal.controller.ts` gives.
 */
@Controller('internal/notifications/campaigns')
@UseGuards(ServiceOnlyGuard)
export class CampaignInternalController {
  constructor(
    private readonly fanOut: CampaignFanOutService,
    private readonly delivery: CampaignDeliveryService,
  ) {}

  /** One bounded pass over every `sending` campaign; answers `{ campaigns, recipients, finished, unreadable }`. */
  @Post('fan-out')
  @HttpCode(HttpStatus.OK)
  run() {
    return this.fanOut.fanOut();
  }

  /** One bounded run of Telegram/Bale sends (F-035-e); answers `{ claimed, sent, failed, deferred, stalled }`. */
  @Post('deliver')
  @HttpCode(HttpStatus.OK)
  deliver() {
    return this.delivery.deliver();
  }

  /** `queued -> sent | failed` with its counter; `{ changed: false }` when it had moved already. */
  @Post('recipients/:id/outcome')
  @HttpCode(HttpStatus.OK)
  async outcome(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodValidationPipe(outcomeSchema)) body: { outcome: RecipientOutcome },
  ) {
    try {
      return await this.fanOut.recordOutcome(id, body.outcome);
    } catch (e) {
      if (e instanceof CampaignFanOutRefused) throw new NotFoundException({ reason: e.reason, message: e.message });
      throw e;
    }
  }
}
