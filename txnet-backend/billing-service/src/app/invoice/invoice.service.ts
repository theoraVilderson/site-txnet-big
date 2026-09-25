import { Injectable } from '@nestjs/common';
import { CouponChannel, InvoiceStatus, Prisma, RedemptionStatus } from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';

import { CatalogOffer, listOffersIn, sellableOfferById } from '../catalog/catalog-reads';
import { deliveryRouteOf } from '../entitlement/delivery';
import { PrismaService } from '../prisma/prisma.service';
import { CouponReservationService } from '../payment/coupon/coupon-reservation';
import {
  CouponValidation,
  CouponValidationService,
  normalizeCouponCodes,
  RejectedCoupon,
} from '../payment/coupon/coupon-validation';

/**
 * An invoice for one catalog variant (F-111-a, spec §5.8 step 1).
 *
 * The server prices it, in USD, from the catalog row in effect now — the body
 * carries no price at all (`invoice.schema.ts`). Then, in **one**
 * `tenantTransaction`: the variant must be for sale to this tenant (live,
 * `public` or `unlisted`, a price in effect; RLS hides another tenant's), the
 * typed codes are validated against this variant and product, the invoice row
 * is written `pending` for {@link INVOICE_TTL_MS}, and the applied codes are
 * held under the invoice's id. A hold that can no longer be taken throws and
 * the whole transaction goes with it, as on a top-up (F-092-h).
 *
 * The tenant's status is the route's (`@TenantCapability('sell')`). Governance
 * restrictions and the reseller cap (F-904) are checked here once their units
 * exist. No money moves: paying is F-111-b, and one that nobody pays is
 * expired by `InvoiceExpiryService`, which gives its holds back.
 */

/** Spec §5.8: "invoice with a 30-minute expiry". */
export const INVOICE_TTL_MS = 30 * 60 * 1000;

export type InvoiceCreateRequest = {
  /** From `X-User-Id`. */
  userId: string;
  variantId: string;
  couponCodes: readonly string[];
  /** Where the codes were typed; absent = the panel. */
  channel?: CouponChannel;
};

/** Money as decimal strings in base currency (C-02). */
export type InvoiceCreated = {
  id: string;
  variantId: string;
  sku: string;
  nameKey: string;
  status: InvoiceStatus;
  amount: string;
  discount: string;
  total: string;
  /** The codes applied, in the order typed, with what each took. */
  applied: Array<{ code: string; discount: string }>;
  /** The codes that took nothing, and why. The invoice is still made without them. */
  rejected: RejectedCoupon[];
  expiresAt: Date;
};

/** One invoice as its owner reads it back (F-111-e): what it was priced at, without the coupon verdicts of its creation. */
export type InvoiceView = Omit<InvoiceCreated, 'rejected'>;

/** Not for sale to this caller: unknown, another tenant's, `admin_only`, switched off, or no price in effect — never told apart. */
export class InvoiceVariantNotFound extends Error {
  constructor(readonly variantId: string) {
    super(`variant ${variantId} is not for sale to this tenant`);
    this.name = 'InvoiceVariantNotFound';
  }
}

const ZERO = new Prisma.Decimal(0);

@Injectable()
export class InvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly coupons: CouponValidationService,
    private readonly reservations: CouponReservationService,
  ) {}

  create(request: InvoiceCreateRequest): Promise<InvoiceCreated> {
    const tenant = TenantContext.current('invoice create');
    const { userId, variantId } = request;

    return tenantTransaction(this.prisma, async (tx) => {
      const now = new Date();
      const offer = await sellableOfferById(tx, variantId, now);
      if (!offer) throw new InvoiceVariantNotFound(variantId);
      // Nothing is sold that nothing can deliver (F-111-d, the user's call
      // 2026-09-25): a paid Grant with no handler could only be refunded.
      const routed = await tx.productVariant.findUnique({ where: { id: offer.variantId }, select: { panelGroupId: true } });
      if (deliveryRouteOf(offer.fulfilmentKind, routed?.panelGroupId ?? null) === null) throw new InvoiceVariantNotFound(variantId);

      const amount = new Prisma.Decimal(offer.price.amount);
      const coupons: CouponValidation = amount.isZero()
        ? // A free variant: nothing to discount, and the engine refuses a zero amount.
          {
            applied: [],
            rejected: normalizeCouponCodes(request.couponCodes).map((code) => ({ code, reason: 'nothing_to_discount' })),
            totalDiscount: ZERO,
            payable: ZERO,
          }
        : await this.coupons.validate(tx, {
            codes: request.couponCodes,
            amount,
            target: { kind: 'purchase', productId: offer.productId, variantId: offer.variantId },
            channel: request.channel ?? CouponChannel.panel,
            userId,
          });

      const id = randomUUID();
      const invoice = await tx.invoice.create({
        data: {
          id,
          tenantId: tenant.id,
          userId,
          variantId: offer.variantId,
          priceId: offer.price.id,
          amount,
          discount: coupons.totalDiscount,
          total: coupons.payable,
          status: InvoiceStatus.pending,
          expiresAt: new Date(now.getTime() + INVOICE_TTL_MS),
        },
      });
      if (coupons.applied.length > 0) {
        await this.reservations.reserve(tx, { userId, orderReferenceId: id, applied: coupons.applied });
      }

      return {
        id,
        variantId: offer.variantId,
        sku: offer.sku,
        nameKey: offer.nameKey,
        status: InvoiceStatus.pending,
        amount: amount.toFixed(2),
        discount: coupons.totalDiscount.toFixed(2),
        total: coupons.payable.toFixed(2),
        applied: coupons.applied.map((a) => ({ code: a.code, discount: a.discount.toFixed(2) })),
        rejected: coupons.rejected,
        expiresAt: invoice.expiresAt,
      };
    });
  }

  /**
   * What the shop lists (F-111-e): every listed variant with a price in
   * effect, less those nothing can deliver — the rule {@link create} refuses
   * with, so the list never offers a buy that answers `variantNotFound`.
   */
  forSale(at: Date = new Date()): Promise<CatalogOffer[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const offers = await listOffersIn(tx, at);
      return offers.filter((o) => deliveryRouteOf(o.fulfilmentKind, o.panelGroupId) !== null);
    });
  }

  /**
   * The caller's own invoice, or `null` — unknown, another tenant's (RLS) and
   * another user's are never told apart. The shop reads it to come back to the
   * same invoice after a top-up (F-111-e). A `pending` one past its clock reads
   * `expired`, as the pay step refuses it, before the sweep flips the row.
   */
  get(userId: string, id: string, at: Date = new Date()): Promise<InvoiceView | null> {
    return tenantTransaction(this.prisma, async (tx) => {
      const row = await tx.invoice.findFirst({
        where: { id, userId },
        include: { variant: { select: { sku: true, nameKey: true, product: { select: { nameKey: true } } } } },
      });
      if (!row) return null;
      // The holds `create` took under this id; confirmed once it was paid.
      const held = await tx.couponRedemption.findMany({
        where: { orderReferenceId: id, userId, status: { in: [RedemptionStatus.pending, RedemptionStatus.confirmed] } },
        select: { discountAppliedAmount: true, coupon: { select: { code: true } } },
        orderBy: { redeemedAt: 'asc' },
      });
      const lapsed = row.status === InvoiceStatus.pending && row.expiresAt.getTime() <= at.getTime();
      return {
        id: row.id,
        variantId: row.variantId,
        sku: row.variant.sku,
        nameKey: row.variant.nameKey ?? row.variant.product.nameKey,
        status: lapsed ? InvoiceStatus.expired : row.status,
        amount: row.amount.toFixed(2),
        discount: row.discount.toFixed(2),
        total: row.total.toFixed(2),
        applied: held.map((h) => ({ code: h.coupon.code, discount: h.discountAppliedAmount.toFixed(2) })),
        expiresAt: row.expiresAt,
      };
    });
  }
}
