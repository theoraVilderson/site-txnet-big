import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ServiceOnlyGuard, TenantCapability, ZodValidationPipe } from '@txnet-backend/shared-core';

import { type AiOfferCouponAnswer, type AiOfferCouponBody, aiOfferCouponSchema, AiOfferCouponService } from './ai-offer-coupon';

/**
 * The seam `worker-service` issues an AI suggestion's personal coupon through
 * (F-038-f3), before it tells the suggestion: the worker owns when, billing
 * owns the coupon and the offer's daily budget. Outside the gate, like every
 * `/api/internal/*` route; `ServiceOnlyGuard` refuses anyone else as a 404.
 * A refusal is an answer, not an error — `{ refused, retryAt? }` in the usual
 * envelope — so the worker can stop or move the suggestion.
 */
@TenantCapability('system')
@Controller('internal/billing/coupons')
@UseGuards(ServiceOnlyGuard)
export class AiOfferCouponController {
  constructor(private readonly coupons: AiOfferCouponService) {}

  @Post('ai-offer')
  @HttpCode(200)
  issue(@Body(new ZodValidationPipe(aiOfferCouponSchema)) body: AiOfferCouponBody): Promise<AiOfferCouponAnswer> {
    return this.coupons.issue(body);
  }
}
