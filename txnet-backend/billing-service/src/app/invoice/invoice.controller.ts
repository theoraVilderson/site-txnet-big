import { Body, ConflictException, Controller, HttpCode, HttpStatus, NotFoundException, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CouponChannel } from '@prisma/client';
import {
  BackendI18nKeys,
  presentsServiceToken,
  RateLimitBucket,
  rateLimitBucketKey,
  TenantCapability,
} from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { LocaleService } from '../locale/locale.service';
import { COUPON_REJECTION_KEY } from '../payment/deposit/deposit.controller';
import { CouponReservationRefused } from '../payment/coupon/coupon-reservation';
import { identityOf } from '../request/identity.middleware';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { InvoiceCreateBody, invoiceCreateSchema } from './invoice.schema';
import { InvoiceService, InvoiceVariantNotFound } from './invoice.service';

const E = BackendI18nKeys.errors.billing;

function toHttp(e: unknown): unknown {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (e instanceof InvoiceVariantNotFound) return new NotFoundException({ i18nKey: E.invoice.variantNotFound, message });
  // A code that validated a moment ago and can no longer be held: nothing was
  // written, and the panel asks again without it — as on a top-up (F-092-h).
  if (e instanceof CouponReservationRefused) {
    return new ConflictException({ i18nKey: COUPON_REJECTION_KEY[e.reason], reason: e.reason, message });
  }
  return e;
}

/**
 * Buying a catalog product (F-111-a, spec §5.8 step 1): `POST /api/billing/invoices`.
 *
 * Behind the gate like every billing route; the user and tenant are its
 * headers'. `sell` is the tenant-status column for an end user buying a
 * service (`status-policy.ts`), so a suspended or onboarding tenant sells
 * nothing. Limited per user: each call holds coupons for 30 minutes.
 */
@Controller('billing/invoices')
export class InvoiceController {
  constructor(
    private readonly invoices: InvoiceService,
    private readonly locale: LocaleService,
    private readonly config: ConfigService,
  ) {}

  @TenantCapability('sell')
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.INVOICE_CREATE, identityOf(req).userId),
    configKey: 'INVOICE_CREATE_RATE_LIMIT',
    windowSec: 900,
  })
  async create(@Body(new ZodValidationPipe(invoiceCreateSchema)) body: InvoiceCreateBody, @Req() req: Request) {
    const lang = (req as { language?: string }).language || this.locale.getDefaultLanguage();
    // `bot` only beside a verified service token, as on a top-up (F-306-a): nothing in the body can claim it.
    const channel = presentsServiceToken(req, this.config.get<string>('SERVICE_AUTH_TOKEN'))
      ? CouponChannel.bot
      : CouponChannel.panel;
    try {
      const invoice = await this.invoices.create({
        userId: identityOf(req).userId,
        variantId: body.variantId,
        couponCodes: body.couponCodes,
        channel,
      });
      return {
        ...invoice,
        rejected: invoice.rejected.map((r) => {
          const key = COUPON_REJECTION_KEY[r.reason];
          return { ...r, message: this.locale.getKey(lang, 'errors', key) || key };
        }),
      };
    } catch (e) {
      throw toHttp(e);
    }
  }
}
