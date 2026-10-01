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
import { BackendI18nKeys, presentsServiceToken, RateLimitBucket, rateLimitBucketKey, ResellerLimitReached, ResellerQuotaExhausted, TenantCapability } from '@txnet-backend/shared-core';
import type { Request } from 'express';

import { LocaleService } from '../locale/locale.service';
import { COUPON_REJECTION_KEY } from '../payment/deposit/deposit.controller';
import { CouponReservationRefused } from '../payment/coupon/coupon-reservation';
import { identityOf } from '../request/identity.middleware';
import { EntitlementRefused, MeteredCapReached } from '../entitlement/grant';
import { PurchaseLimitReached } from '../entitlement/purchase-limits';
import { RateLimit } from '../request/rate-limit';
import { ZodValidationPipe } from '../request/zod-validation.pipe';
import { InvoicePayRejection, InvoicePaymentService, InvoiceUnpayable } from './invoice-payment.service';
import { InvoiceCreateBody, invoiceCreateSchema } from './invoice.schema';
import { InvoiceCancelRefusal, InvoiceNotCancellable, InvoiceService, InvoiceVariantNotFound } from './invoice.service';

const E = BackendI18nKeys.errors.billing;

/** Every way a pay is refused, keyed exhaustively so a new reason does not compile unanswered. */
const PAY_REFUSAL_KEY: Record<InvoicePayRejection, string> = {
  not_found: E.invoice.notFound,
  already_paid: E.invoice.alreadyPaid,
  expired: E.invoice.expired,
  cancelled: E.invoice.cancelled,
  insufficient_balance: E.invoice.insufficientBalance,
};

/** Every way a cancel is refused (F-114-d), keyed exhaustively like a pay's. */
const CANCEL_REFUSAL_KEY: Record<InvoiceCancelRefusal, string> = {
  not_found: E.invoice.notFound,
  already_paid: E.invoice.alreadyPaid,
};

function toHttp(e: unknown): unknown {
  const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (e instanceof InvoiceNotCancellable) {
    const body = { i18nKey: CANCEL_REFUSAL_KEY[e.reason], reason: e.reason, message };
    return e.reason === 'not_found' ? new NotFoundException(body) : new ConflictException(body);
  }
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
      currencyCode: e.shortfall.currencyCode,
    };
    return new ConflictException(facts ? { ...body, facts } : body);
  }
  // Past the user's cap of open metered Grants (F-118-ao), at the invoice or
  // at its payment: nothing was written. The cap rides as `facts`, so the
  // panel can name it and point to a ticket.
  // Past the reseller's room on the platform's panels (F-019-o): the buyer is
  // told it is not available now — the reseller's limit is not the buyer's
  // business, so no figures ride along. Nothing was written.
  if (e instanceof ResellerLimitReached) {
    return new ConflictException({ i18nKey: E.invoice.notAvailableNow, reason: e.reason, message });
  }
  // Past the reseller's package quota for the product, or overage it cannot pay (F-019-v6, ADR-0107
  // point 11): the same "not available now", at the invoice or at its payment. No figures.
  if (e instanceof ResellerQuotaExhausted) {
    return new ConflictException({ i18nKey: E.invoice.notAvailableNow, reason: e.reason, message });
  }
  // Past the buyer's own purchases in a day, week or month (F-019-t7): the
  // buyer is the one bounded, so the window and the limit ride as `facts`.
  if (e instanceof PurchaseLimitReached) {
    const i18nKey = { day: E.invoice.purchaseLimitDay, week: E.invoice.purchaseLimitWeek, month: E.invoice.purchaseLimitMonth }[e.window];
    return new ConflictException({ i18nKey, reason: e.reason, message, facts: e.facts });
  }
  if (e instanceof MeteredCapReached) {
    return new ConflictException({
      i18nKey: E.invoice.meteredCapReached,
      reason: e.reason,
      message,
      facts: { cap: e.cap, open: e.open },
    });
  }
  // The variant was switched off between the invoice and its payment: nothing was written.
  if (e instanceof EntitlementRefused && (e.reason === 'variant_not_found' || e.reason === 'variant_not_assignable')) {
    return new NotFoundException({ i18nKey: E.invoice.variantNotFound, message });
  }
  // The seller cannot sell it on the platform's panels now — its package prices
  // no traffic there, or it cannot pay the wholesale (F-118-p). Nothing was
  // written; the buyer is told only that it is not for sale.
  if (e instanceof EntitlementRefused && (e.reason === 'wholesale_rate_missing' || e.reason === 'wholesale_unfunded')) {
    return new ConflictException({ i18nKey: E.invoice.variantNotFound, reason: e.reason, message });
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

  /**
   * Giving up one's own pending invoice (F-114-d): the shop replaces the invoice
   * when the codes change, and this gives the old one's coupon holds back at
   * once instead of after its 30 minutes. No capability: it sells nothing, and
   * a suspended tenant's shopper may still let go of what they held.
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RateLimit({
    key: (req) => rateLimitBucketKey(RateLimitBucket.INVOICE_CANCEL, identityOf(req).userId),
    configKey: 'INVOICE_CANCEL_RATE_LIMIT',
    windowSec: 900,
  })
  async cancel(@Param('id', new ParseUUIDPipe()) id: string, @Req() req: Request) {
    try {
      return await this.invoices.cancel(identityOf(req).userId, id);
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
      productNameKey: o.productNameKey,
      descriptionKey: o.descriptionKey,
      categoryKey: o.categoryKey,
      categories: o.categories,
      fulfilmentKind: o.fulfilmentKind,
      durationDays: o.durationDays,
      billingMode: o.billingMode,
      quotas: o.quotas,
      price: o.price.amount,
      currencyCode: o.price.currencyCode,
      rateCards: o.rateCards,
    }));
  }
}
