import {
  BadRequestException,
  Body,
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
import { BackendI18nKeys, CredentialUnavailable } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { LocaleService } from '../../locale/locale.service';
import { identityOf } from '../../request/identity.middleware';
import { ZodValidationPipe } from '../../request/zod-validation.pipe';
import type { CouponRejection } from '../coupon/coupon-validation';
import { GatewayFailure, ProviderNotSupported } from '../gateway/payment-provider';
import { AmountOutOfGatewayRange, RateOutOfRange, RateUnavailable } from '../pricing/gateway-pricing';
import { DepositGatewayNotFound, DepositQuoteService } from './deposit-quote.service';
import { DepositQuoteBody, depositQuoteSchema } from './deposit.schema';

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
  if (
    e instanceof RateUnavailable ||
    e instanceof RateOutOfRange ||
    e instanceof GatewayFailure ||
    e instanceof CredentialUnavailable ||
    e instanceof ProviderNotSupported
  ) {
    return new ServiceUnavailableException({ i18nKey: E.gatewayUnavailable, message });
  }
  return e;
}

/**
 * The panel's top-up page (F-092-o): `GET /api/billing/deposit/gateways` and
 * `POST /api/billing/deposit/quote`. Behind the gate like every billing route
 * (`app.module.ts`); the user and the tenant come from its headers, never from
 * the body.
 */
@Controller('billing/deposit')
export class DepositController {
  constructor(
    private readonly deposits: DepositQuoteService,
    private readonly locale: LocaleService,
  ) {}

  @Get('gateways')
  gateways() {
    return this.deposits.listGateways();
  }

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  async quote(@Body(new ZodValidationPipe(depositQuoteSchema)) body: DepositQuoteBody, @Req() req: Request) {
    const { userId } = identityOf(req);
    const lang = (req as { language?: string }).language || this.locale.getDefaultLanguage();

    try {
      const quote = await this.deposits.quote({
        userId,
        gatewayId: body.gatewayId,
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
}
