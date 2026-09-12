import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  BackendI18nKeys,
  CredentialUnavailable,
  RateLimitBucket,
  rateLimitBucketKey,
} from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { LocaleService } from '../../locale/locale.service';
import { identityOf } from '../../request/identity.middleware';
import { RateLimit } from '../../request/rate-limit';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import { CouponReservationRefused } from '../coupon/coupon-reservation';
import type { CouponRejection } from '../coupon/coupon-validation';
import { GatewayFailure, ProviderNotSupported } from '../gateway/payment-provider';
import { AmountOutOfGatewayRange, RateOutOfRange, RateUnavailable } from '../pricing/gateway-pricing';
import { DepositGatewayNotFound, DepositQuoteService } from './deposit-quote.service';
import { DepositCallbackUnavailable, DepositStartService } from './deposit-start.service';
import { DepositQuoteBody, depositQuoteSchema, DepositStartBody, depositStartSchema } from './deposit.schema';

const E = BackendI18nKeys.errors.billing;

/** Every rejection reason has a message; a new reason does not compile until it gets one. */
const COUPON_REJECTION_KEY: Record<CouponRejection, string> = {
  not_found: E.coupon.notFound,
  not_a_discount: E.coupon.notADiscount,
  expired: E.coupon.expired,
  out_of_scope: E.coupon.outOfScope,
  below_min_purchase: E.coupon.belowMinPurchase,
  per_user_limit_reached: E.coupon.perUserLimitReached,
  capacity_reached: E.coupon.capacityReached,
  nothing_to_discount: E.coupon.nothingToDiscount,
};

/**
 * The first route to expose the calculator's, the port's and the vault's
 * errors, so it is where they become i18n keys (C-01). The original error goes
 * to the log through `message`, never to the client.
 *
 * Everything that means "this gateway cannot take a payment now" — no usable
 * rate (F-0607), a provider failure, no merchant id in the vault, no driver —
 * is one answer: the user's move is the same, pick another gateway.
 */
function toHttp(e: unknown): unknown {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (e instanceof DepositGatewayNotFound) return new NotFoundException({ i18nKey: E.gatewayNotFound, message });
  if (e instanceof AmountOutOfGatewayRange) return new BadRequestException({ i18nKey: E.amountOutOfRange, message });
  // A coupon that validated a moment ago and can no longer be held is a state
  // of the world, not a bad field: the panel re-quotes and shows the breakdown
  // without it (F-092-h). Nothing was written — the hold's refusal rolled the
  // payment back with it.
  if (e instanceof CouponReservationRefused) {
    return new ConflictException({ i18nKey: COUPON_REJECTION_KEY[e.reason], reason: e.reason, message });
  }
  if (
    e instanceof RateUnavailable ||
    e instanceof RateOutOfRange ||
    e instanceof GatewayFailure ||
    e instanceof CredentialUnavailable ||
    e instanceof ProviderNotSupported ||
    // The tenant owns no host a bank could answer on (ADR-0020). Not this
    // gateway's fault, but the user's move is the same and the cause is an
    // operator's to fix, so it travels as the log line and not as a sentence.
    e instanceof DepositCallbackUnavailable
  ) {
    return new ServiceUnavailableException({ i18nKey: E.gatewayUnavailable, message });
  }
  return e;
}

/**
 * The panel's top-up page (F-092-o, F-092-i): `GET .../gateways`,
 * `POST .../quote` and `POST .../start`. Behind the gate like every billing
 * route (`app.module.ts`); the user and the tenant come from its headers, never
 * from the body. All three are limited per user (F-092-r), `start` far harder
 * than the two reads — it holds coupons and mints an authority at a bank.
 */
@Controller('billing/deposit')
export class DepositController {
  constructor(
    private readonly deposits: DepositQuoteService,
    private readonly starts: DepositStartService,
    private readonly locale: LocaleService,
  ) {}

  @Get('gateways')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_GATEWAYS, identityOf(req).userId),
    configKey: 'DEPOSIT_GATEWAYS_RATE_LIMIT',
    windowSec: 900,
  })
  gateways() {
    return this.deposits.listGateways();
  }

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_QUOTE, identityOf(req).userId),
    configKey: 'DEPOSIT_QUOTE_RATE_LIMIT',
    windowSec: 900,
  })
  async quote(@Body(new ZodValidationPipe(depositQuoteSchema)) body: DepositQuoteBody, @Req() req: Request) {
    const { userId } = identityOf(req);
    const lang = (req as { language?: string }).language || this.locale.getDefaultLanguage();

    try {
      const quote = await this.deposits.quote({
        userId,
        gatewayId: body.gatewayId,
        source: body.source,
        amount: new Prisma.Decimal(body.amount),
        couponCodes: body.couponCodes,
      });
      return {
        ...quote,
        rejected: quote.rejected.map((r) => {
          const key = COUPON_REJECTION_KEY[r.reason];
          return { ...r, message: this.locale.getKey(lang, 'errors', key) || key };
        }),
      };
    } catch (e) {
      throw toHttp(e);
    }
  }

  /**
   * Start the payment the quote described. The body is the quote's, because the
   * price is recomputed here from the same inputs by the same code — a client
   * never sends back a number it was shown (F-0612).
   *
   * The answer is a `redirectUrl` the panel sends the browser to, or, on a fully
   * discounted top-up, `free: true` with the wallet already credited and nowhere
   * to go.
   */
  @Post('start')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.DEPOSIT_START, identityOf(req).userId),
    configKey: 'DEPOSIT_START_RATE_LIMIT',
    windowSec: 900,
  })
  async start(@Body(new ZodValidationPipe(depositStartSchema)) body: DepositStartBody, @Req() req: Request) {
    const { userId } = identityOf(req);
    try {
      return await this.starts.start({
        userId,
        gatewayId: body.gatewayId,
        source: body.source,
        amount: new Prisma.Decimal(body.amount),
        couponCodes: body.couponCodes,
      });
    } catch (e) {
      throw toHttp(e);
    }
  }
}
