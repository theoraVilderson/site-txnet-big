import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
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
import { EntitlementRefused } from '../entitlement/grant';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { InvoicePayRejection, InvoicePaymentService, InvoiceUnpayable } from './invoice-payment.service';
import { InvoiceCreateBody, invoiceCreateSchema } from './invoice.schema';
import { InvoiceService, InvoiceVariantNotFound } from './invoice.service';

const E = BackendI18nKeys.errors.billing;

/** Every way a pay is refused, keyed exhaustively so a new reason does not compile unanswered. */
const PAY_REFUSAL_KEY: Record<InvoicePayRejection, string> = {
  not_found: E.invoice.notFound,
  already_paid: E.invoice.alreadyPaid,
  expired: E.invoice.expired,
  cancelled: E.invoice.cancelled,
  insufficient_balance: E.invoice.insufficientBalance,
};

function toHttp(e: unknown): unknown {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (e instanceof InvoiceVariantNotFound) return new NotFoundException({ i18nKey: E.invoice.variantNotFound, message });
  if (e instanceof InvoiceUnpayable) {
    const body = { i18nKey: PAY_REFUSAL_KEY[e.reason], reason: e.reason, message };
    if (e.reason === 'not_found') return new NotFoundException(body);
    // The shortfall rides along as the envelope's `error.facts` so the panel can
    // offer the top-up for exactly it (F-111-c, F-111-e) — any other field the
    // exception filter drops. `missing` is already whole cents, rounded up —
    // toFixed(2) only formats it.
    const facts = e.shortfall && {
      total: e.shortfall.total.toFixed(2),
      balance: e.shortfall.balance.toFixed(2),
      missing: e.shortfall.missing.toFixed(2),
    };
    return new ConflictException(facts ? { ...body, facts } : body);
  }
  // The variant was switched off between the invoice and its payment: nothing was written.
  if (e instanceof EntitlementRefused && (e.reason === 'variant_not_found' || e.reason === 'variant_not_assignable')) {
    return new NotFoundException({ i18nKey: E.invoice.variantNotFound, message });
  }
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
    private readonly payments: InvoicePaymentService,
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

  /**
   * The caller's own invoice (F-111-e): what the shop reads to come back to the
   * same invoice after a top-up. Unknown, another tenant's and another user's
   * are one `404 notFound`. No capability: reading what was already priced
   * sells nothing.
   */
  @Get(':id')
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.INVOICE_READ, identityOf(req).userId),
    configKey: 'INVOICE_READ_RATE_LIMIT',
    windowSec: 900,
  })
  async get(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    const invoice = await this.invoices.get(identityOf(req).userId, id);
    if (!invoice) throw new NotFoundException({ i18nKey: E.invoice.notFound, message: `invoice ${id} not found for this user` });
    return invoice;
  }

  /**
   * Paying it from the wallet (F-111-b, spec §5.8 step 2): one transaction,
   * exactly once under concurrent calls — `InvoicePaymentService`. `200` with
   * the Grant, `pending` until delivery, and its subscription token, once.
   */
  @TenantCapability('sell')
  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.INVOICE_PAY, identityOf(req).userId),
    configKey: 'INVOICE_PAY_RATE_LIMIT',
    windowSec: 900,
  })
  async pay(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    try {
      return await this.payments.pay({ userId: identityOf(req).userId, invoiceId: id });
    } catch (e) {
      throw toHttp(e);
    }
  }
}

/**
 * What the shop lists (F-111-e): `GET /api/billing/offers` — every listed
 * variant this tenant sells with the price in effect, less what nothing can
 * deliver (`InvoiceService.forSale`). `sell`, like buying: a tenant that
 * sells nothing lists nothing.
 */
@Controller('billing/offers')
export class OffersController {
  constructor(private readonly invoices: InvoiceService) {}

  @TenantCapability('sell')
  @Get()
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.SHOP_OFFERS, identityOf(req).userId),
    configKey: 'SHOP_OFFERS_RATE_LIMIT',
    windowSec: 900,
  })
  async list() {
    const offers = await this.invoices.forSale();
    return offers.map((o) => ({
      variantId: o.variantId,
      sku: o.sku,
      nameKey: o.nameKey,
      productId: o.productId,
      descriptionKey: o.descriptionKey,
      categoryKey: o.categoryKey,
      fulfilmentKind: o.fulfilmentKind,
      durationDays: o.durationDays,
      billingMode: o.billingMode,
      quotas: o.quotas,
      price: o.price.amount,
    }));
  }
}
