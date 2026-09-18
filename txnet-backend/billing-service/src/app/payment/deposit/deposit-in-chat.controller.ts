import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { RateLimitBucket, rateLimitBucketKey, ServiceOnlyGuard, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { DepositInChatService, InChatPaidResult, InChatPaymentRef, PreCheckoutVerdict } from './deposit-in-chat.service';
import { InChatPaidBody, inChatPaidSchema, InChatPreCheckoutBody, inChatPreCheckoutSchema } from './deposit.schema';

const refOf = (body: InChatPreCheckoutBody): InChatPaymentRef => ({
  sender: { platform: body.platform, senderId: body.senderId, botTenantId: body.botTenantId },
  paymentId: body.paymentId,
  currency: body.currency,
  totalAmount: BigInt(body.totalAmount),
});

/** One budget per person paying, whichever bot relays them. */
const senderBucket = (req: Request) => {
  const body = (req.body ?? {}) as Partial<InChatPreCheckoutBody>;
  return rateLimitBucketKey(RateLimitBucket.DEPOSIT_IN_CHAT, `${body.platform}:${body.senderId}`);
};

/**
 * The bot's relay of an in-chat payment (F-104-k, D-32, F-104-ab):
 * `POST /api/internal/billing/deposit/in-chat/pre-checkout` and `.../paid`.
 *
 * **Outside the gate, service-only.** The events belong to the payment, not to
 * a chat session: the payer may have started it in a Mini App and never signed
 * in to the chat, or be the owner in another tenant's bot. So the bot relays
 * the sender's messenger id and its own tenant beside `SERVICE_AUTH_TOKEN`, and
 * `DepositInChatService` admits the event only from the payer the payment
 * recorded. `/api/internal/*` is not routed by Traefik and `IdentityMiddleware`
 * excludes it, as for `DepositInternalController`; the tenant is the
 * payment's. Refused as a neutral 404 without the token.
 *
 * Both answer 200 with a verdict rather than an error status: the bot has to
 * answer the messenger either way, and a refusal is an ordinary outcome.
 */
@TenantCapability('system')
@Controller('internal/billing/deposit/in-chat')
@UseGuards(ServiceOnlyGuard)
export class DepositInChatController {
  constructor(private readonly inChat: DepositInChatService) {}

  @Post('pre-checkout')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ key: senderBucket, configKey: 'DEPOSIT_IN_CHAT_RATE_LIMIT', windowSec: 900 })
  preCheckout(@Body(new ZodValidationPipe(inChatPreCheckoutSchema)) body: InChatPreCheckoutBody): Promise<PreCheckoutVerdict> {
    return this.inChat.preCheckout(refOf(body));
  }

  @Post('paid')
  @HttpCode(HttpStatus.OK)
  @RateLimit({ key: senderBucket, configKey: 'DEPOSIT_IN_CHAT_RATE_LIMIT', windowSec: 900 })
  paid(@Body(new ZodValidationPipe(inChatPaidSchema)) body: InChatPaidBody): Promise<InChatPaidResult> {
    return this.inChat.paid({ ...refOf(body), chargeId: body.chargeId });
  }
}
