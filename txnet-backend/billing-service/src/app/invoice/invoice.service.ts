import { Injectable } from '@nestjs/common';
import { CouponChannel, InvoiceStatus, Prisma, RedemptionStatus, VariantBillingMode } from '@prisma/client';
import { admitProductSale, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';

import { CatalogOffer, listOffersIn, sellableOfferById } from '../catalog/catalog-reads';
import { sellsTrafficToday } from '../catalog/traffic-quota';
import { deliveryRouteOf } from '../entitlement/delivery';
import { assertMeteredRoom } from '../entitlement/metered-cap';
import { assertPurchaseRoom } from '../entitlement/purchase-limits';
import { assertPlatformGrantRoom } from '../entitlement/reseller-room';
import { deliverableGroupIds } from '../traffic/group-fulfilment';
import { discountRuleFor } from './discount/discount-rule';
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
 * best discount rule with no code is taken (F-114-h, D-45), the typed codes
 * are validated against this variant and product and against what the rule
 * left, the invoice row
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
  /** What every amount here is in: the invoice's own, its price's (ADR-0098 part 3, F-116-h2). */
  currencyCode: string;
  /** The rule with no code taken before the coupons (F-114-h), or null. `discount` includes it. */
  automaticDiscount: AutomaticDiscount | null;
  /** The codes applied, in the order typed, with what each took. */
  applied: Array<{ code: string; discount: string }>;
  /** The codes that took nothing, and why. The invoice is still made without them. */
  rejected: RejectedCoupon[];
  expiresAt: Date;
};

/** What a discount rule took, and its label for the buyer (F-114-h). */
export type AutomaticDiscount = { ruleId: string; name: string; discount: string };

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

/** Why an invoice could not be cancelled: unknown to this user, or paid already (its holds are uses now). */
export type InvoiceCancelRefusal = 'not_found' | 'already_paid';

export class InvoiceNotCancellable extends Error {
  constructor(
    readonly reason: InvoiceCancelRefusal,
    readonly invoiceId: string,
  ) {
    super(`invoice ${invoiceId} cannot be cancelled: ${reason}`);
    this.name = 'InvoiceNotCancellable';
  }
}

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
      const routed = await tx.productVariant.findUnique({ where: { id: offer.variantId }, select: { panelGroupId: true, billingMode: true } });
      const groupId = routed?.panelGroupId ?? null;
      const route = deliveryRouteOf(offer.fulfilmentKind, groupId);
      // ...nor a prepaid network Grant with no traffic to fill it (F-111-p).
      if (route === null || !sellsTrafficToday(offer)) throw new InvoiceVariantNotFound(variantId);
      // ...nor what no panel of its group could ever place (F-111-i).
      if (route === 'panel_group' && groupId && !(await deliverableGroupIds(tx, [groupId])).has(groupId)) {
        throw new InvoiceVariantNotFound(variantId);
      }

      // A metered buy past the cap is refused before an invoice exists, and
      // again at issue under the same lock (F-118-ao).
      if (routed?.billingMode === VariantBillingMode.metered) await assertMeteredRoom(tx, userId);
      // ...nor past the buyer's purchases in a day, week or month (F-019-t7), told before paying and again at issue.
      await assertPurchaseRoom(tx, userId);
      // ...nor past its reseller's room on the platform's panels (F-019-o), told before paying.
      await assertPlatformGrantRoom(tx, offer.variantId);
      // ...nor past its reseller's package quota for the product, or overage it cannot pay (F-019-v6):
      // asked now, consumed at issue.
      await admitProductSale(tx, { tenantId: tenant.id, product: { id: offer.productId, tenantId: offer.tenantId }, now });

      const amount = new Prisma.Decimal(offer.price.amount);
      // The best rule with no code comes first; the coupons see what it left (D-45).
      const rule = await discountRuleFor(tx, { userId, productId: offer.productId, at: now }, amount);
      const ruleDiscount = rule?.discount ?? ZERO;
      const couponBase = amount.minus(ruleDiscount);
      const coupons: CouponValidation = couponBase.isZero()
        ? // A free variant, or one a rule took whole: nothing to discount, and the engine refuses a zero amount.
          {
            applied: [],
            rejected: normalizeCouponCodes(request.couponCodes).map((code) => ({ code, reason: 'nothing_to_discount' })),
            totalDiscount: ZERO,
            payable: ZERO,
          }
        : await this.coupons.validate(tx, {
            codes: request.couponCodes,
            amount: couponBase,
            // The price's own, which the invoice records (F-116-d, F-116-h6).
            currencyCode: offer.price.currencyCode,
            target: { kind: 'purchase', productId: offer.productId, variantId: offer.variantId },
            channel: request.channel ?? CouponChannel.panel,
            userId,
            // A purchase is inside this tenant's books: its own pin converts (F-116-j).
            ratesTenantId: tenant.id,
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
          // The price's own (F-116-d): the offer took only a price in the tenant's currency.
          currencyCode: offer.price.currencyCode,
          discount: ruleDiscount.plus(coupons.totalDiscount),
          total: coupons.payable,
          discountRuleId: rule?.rule.id ?? null,
          ruleDiscount,
          status: InvoiceStatus.pending,
          expiresAt: new Date(now.getTime() + INVOICE_TTL_MS),
        },
      });
      if (coupons.applied.length > 0) {
        await this.reservations.reserve(tx, { userId, orderReferenceId: id, currencyCode: invoice.currencyCode, applied: coupons.applied });
      }

      return {
        id,
        variantId: offer.variantId,
        sku: offer.sku,
        nameKey: offer.nameKey,
        status: InvoiceStatus.pending,
        amount: amount.toFixed(2),
        discount: ruleDiscount.plus(coupons.totalDiscount).toFixed(2),
        total: coupons.payable.toFixed(2),
        currencyCode: invoice.currencyCode,
        automaticDiscount: rule ? { ruleId: rule.rule.id, name: rule.rule.name, discount: rule.discount.toFixed(2) } : null,
        applied: coupons.applied.map((a) => ({ code: a.code, discount: a.discount.toFixed(2) })),
        rejected: coupons.rejected,
        expiresAt: invoice.expiresAt,
      };
    });
  }

  /**
   * What the shop lists (F-111-e): every listed variant with a price in
   * effect, less those nothing can deliver — no handler, or a group with no
   * panel that could place it (F-111-i), or no traffic to fill (F-111-p) —
   * the rule {@link create} refuses with, so the list never offers a buy
   * that answers `variantNotFound`.
   */
  forSale(at: Date = new Date()): Promise<CatalogOffer[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const routed = (await listOffersIn(tx, at))
        .filter(sellsTrafficToday)
        .map((offer) => ({ offer, route: deliveryRouteOf(offer.fulfilmentKind, offer.panelGroupId) }))
        .filter((r) => r.route !== null);
      const deliverable = await deliverableGroupIds(
        tx,
        routed.flatMap((r) => (r.route === 'panel_group' && r.offer.panelGroupId ? [r.offer.panelGroupId] : [])),
      );
      return routed.filter((r) => r.route !== 'panel_group' || deliverable.has(r.offer.panelGroupId ?? '')).map((r) => r.offer);
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
        include: {
          variant: { select: { sku: true, nameKey: true, product: { select: { nameKey: true } } } },
          discountRule: { select: { name: true } },
        },
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
        currencyCode: row.currencyCode,
        automaticDiscount:
          row.discountRuleId && row.discountRule
            ? { ruleId: row.discountRuleId, name: row.discountRule.name, discount: row.ruleDiscount.toFixed(2) }
            : null,
        applied: held.map((h) => ({ code: h.coupon.code, discount: h.discountAppliedAmount.toFixed(2) })),
        expiresAt: row.expiresAt,
      };
    });
  }

  /**
   * The caller gives up their own pending invoice (F-114-d): the shop replaces
   * it when the codes change, and a code held by the old one would otherwise
   * count against the new one for 30 minutes (`per_user_limit_reached`). The
   * flip is guarded by `pending`, as the sweep's is, so an invoice paid under
   * its row lock first matches nothing and keeps its holds. One already
   * `cancelled` or `expired` holds nothing and is answered as it is.
   */
  cancel(userId: string, id: string): Promise<{ id: string; status: InvoiceStatus }> {
    return tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.invoice.updateMany({
        where: { id, userId, status: InvoiceStatus.pending },
        data: { status: InvoiceStatus.cancelled },
      });
      if (count === 1) {
        await this.reservations.release(tx, id, RedemptionStatus.cancelled);
        return { id, status: InvoiceStatus.cancelled };
      }
      const row = await tx.invoice.findFirst({ where: { id, userId }, select: { status: true } });
      if (!row) throw new InvoiceNotCancellable('not_found', id);
      if (row.status === InvoiceStatus.cancelled || row.status === InvoiceStatus.expired) return { id, status: row.status };
      throw new InvoiceNotCancellable('already_paid', id);
    });
  }
}
