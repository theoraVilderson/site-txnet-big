import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { DepositInChatService, InChatPaidResult, InChatPaymentRef, PreCheckoutVerdict } from './deposit-in-chat.service';
import { InChatPaidBody, inChatPaidSchema, InChatPreCheckoutBody, inChatPreCheckoutSchema } from './deposit.schema';

/** The payer is the gate's, never the body's. */
const refOf = (body: InChatPreCheckoutBody, req: Request): InChatPaymentRef => ({
  userId: identityOf(req).userId,
  paymentId: body.paymentId,
  currency: body.currency,
  totalAmount: BigInt(body.totalAmount),
});

/**
 * The bot's relay of an in-chat payment (F-104-k, D-32):
 * `POST /api/billing/deposit/in-chat/pre-checkout` and `.../paid`.
 *
 * **Behind the gate and service-only at once.** The bot calls as the payer,
 * with the chat's access token, like the rest of its top-up (F-306-a) — so the
 * user and tenant come from the gate's headers and a payment is found only
 * inside them. `ServiceOnlyGuard` adds that only `bot-service` may: a panel
 * user holding their own token must not be able to say "paid". Refused as a
 * neutral 404, like every service seam.
 *
 * Both answer 200 with a verdict rather than an error status: the bot has to
 * answer the messenger either way, and a refusal is an ordinary outcome.
 */
@Controller('billing/deposit/in-chat')
@UseGuards(ServiceOnlyGuard)
export class DepositInChatController {
  constructor(private readonly inChat: DepositInChatService) {}

  @TenantCapability('endUserDeposit')
  @Post('pre-checkout')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_IN_CHAT, identityOf(req).userId),
    configKey: 'DEPOSIT_IN_CHAT_RATE_LIMIT',
    windowSec: 900,
  })
  preCheckout(
    @Body(new ZodValidationPipe(inChatPreCheckoutSchema)) body: InChatPreCheckoutBody,
    @Req() req: Request,
  ): Promise<PreCheckoutVerdict> {
    return this.inChat.preCheckout(refOf(body, req));
  }

  @TenantCapability('system')
  @Post('paid')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_IN_CHAT, identityOf(req).userId),
    configKey: 'DEPOSIT_IN_CHAT_RATE_LIMIT',
    windowSec: 900,
  })
  paid(@Body(new ZodValidationPipe(inChatPaidSchema)) body: InChatPaidBody, @Req() req: Request): Promise<InChatPaidResult> {
    return this.inChat.paid({ ...refOf(body, req), chargeId: body.chargeId });
  }
}
