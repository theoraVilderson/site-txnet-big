import { Body, ConflictException, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { BackendI18nKeys, RateLimitBucket, rateLimitBucketKey, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { GiftCodeRefused, GiftRejection, GiftRedemptionService } from './gift-redemption.service';
import { GiftRedeemBody, giftRedeemSchema } from './gift.schema';

const E = BackendI18nKeys.errors.billing;

/** Every refusal has a message; a new reason does not compile until it gets one. */
const GIFT_REJECTION_KEY: Record<GiftRejection, string> = {
  not_found: E.gift.notFound,
  not_a_gift_code: E.gift.notAGiftCode,
  expired: E.gift.expired,
  per_user_limit_reached: E.gift.perUserLimitReached,
  capacity_reached: E.gift.capacityReached,
};

/**
 * The panel's gift-code box (F-092-m): `POST /api/billing/gift/redeem`. Behind
 * the gate like every billing route (`app.module.ts`); the user and the tenant
 * come from its headers, never from the body.
 *
 * A refusal is `409`, as legacy answered it: the request was well-formed and
 * the code is simply not redeemable, which is a state of the world rather than
 * a bad field. The reason travels as an `i18nKey` (C-01) and the raw error only
 * to the log.
 *
 * **The limit is the point of this route, not an afterthought.** A gift code is
 * a bearer secret with money behind it, and this is the only route that says
 * whether one exists — so an unlimited version is a code-guessing oracle. The
 * budget is deliberately far below the read routes'.
 */
@Controller('billing/gift')
export class GiftController {
  constructor(private readonly gifts: GiftRedemptionService) {}

  @TenantCapability('endUserDeposit')
  @Post('redeem')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.GIFT_REDEEM, identityOf(req).userId),
    configKey: 'GIFT_REDEEM_RATE_LIMIT',
    windowSec: 900,
  })
  async redeem(@Body(new ZodValidationPipe(giftRedeemSchema)) body: GiftRedeemBody, @Req() req: Request) {
    const { userId } = identityOf(req);
    try {
      const result = await this.gifts.redeem({ userId, code: body.code });
      if (result.kind === 'free_grant') {
        // D-35: the subscription key is shown this once; it is never stored.
        return {
          kind: result.kind,
          code: result.code,
          grant: {
            id: result.grant.id,
            variantId: result.grant.variantId,
            startsAt: result.grant.startsAt,
            endsAt: result.grant.endsAt,
            featureKeys: result.grant.featureKeys,
          },
          subscriptionKey: result.token,
        };
      }
      return {
        kind: result.kind,
        code: result.code,
        credited: result.credited.toFixed(2),
        balance: result.balanceAfter.toFixed(2),
      };
    } catch (e) {
      if (e instanceof GiftCodeRefused) {
        throw new ConflictException({
          i18nKey: GIFT_REJECTION_KEY[e.reason],
          reason: e.reason,
          message: `${e.name}: ${e.message}`,
        });
      }
      throw e;
    }
  }
}
