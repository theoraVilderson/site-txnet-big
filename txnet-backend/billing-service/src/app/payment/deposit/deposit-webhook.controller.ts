import { Controller, HttpCode, NotFoundException, Post, RawBodyRequest, Req, UnauthorizedException } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { RateLimit } from '../../request/rate-limit';
import { webhookGatewayOf } from '../../request/webhook-gateway.middleware';
import { DepositWebhookService } from './deposit-webhook.service';

/**
 * Where a provider's server posts a payment's result (F-104-b, ADR-0051).
 *
 * The **second** public route in `billing-service`, and a controller of its own
 * for the callback's reason: nothing here may assume an identity. Traefik routes
 * it without `my-auth`, and `WebhookGatewayMiddleware` has already turned the
 * path's gateway into a tenant scope — an unknown gateway never reaches this.
 *
 * The body is read as the **raw bytes** (`rawBody: true` in `main.ts`): a
 * signature is over what was sent, and re-serialized JSON is not that.
 *
 * Limited per **gateway**, not per caller — there is none. One gateway's whole
 * event stream shares a budget, sized well above a provider's retry burst.
 */
@Controller('billing/deposit/webhook')
export class DepositWebhookController {
  constructor(private readonly webhooks: DepositWebhookService) {}

  @Post(':provider/:gatewayId')
  @HttpCode(200)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_WEBHOOK, gatewayIdOf(req) || 'none'),
    configKey: 'DEPOSIT_WEBHOOK_RATE_LIMIT',
    windowSec: 60,
  })
  async webhook(@Req() req: RawBodyRequest<Request>) {
    const answer = await this.webhooks.handle(webhookGatewayOf(req), {
      rawBody: req.rawBody ?? Buffer.alloc(0),
      headers: req.headers,
    });
    if (answer === 'not_found') throw new NotFoundException();
    if (answer === 'unauthorized') throw new UnauthorizedException();
    return { received: true };
  }
}

/** The gateway id in the path, as the router parsed it. */
function gatewayIdOf(req: { params?: Record<string, string> }): string {
  return req.params?.['gatewayId'] ?? '';
}
