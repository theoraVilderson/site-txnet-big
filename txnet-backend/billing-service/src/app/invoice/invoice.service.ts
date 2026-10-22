import { Injectable } from '@nestjs/common';
import { CouponChannel, InvoiceStatus, Prisma, RedemptionStatus } from '@prisma/client';
import { TenantContext, tenantTransaction, moneyText } from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';

import { CatalogOffer, listOffersIn } from '../catalog/catalog-reads';
import { moveSales } from '../catalog/sales-counts';
import { sellsTrafficToday } from '../catalog/traffic-quota';
import { deliveryRouteOf } from '../entitlement/delivery';
import { deliverableGroupIds } from '../traffic/group-fulfilment';
import { discountRuleFor } from './discount/discount-rule';
import { CustomAmount, customRenewalSaleOf, CustomRenewalView, customRenewalView, renewalRateFor } from './custom-renewal';
import { invoiceItemOf, renewalColumns } from './invoice-item';
import { RenewalPlansView, renewalPlansView, renewalPlansOf } from './renewal-invoice';
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
 * The tenant's status is the route's (`@TenantCapability('sell')`); the
 * buyer's restrictions are `assertBuyerRoom`'s (F-030-e). No money moves: paying is F-111-b, and one that nobody pays is
 * expired by `InvoiceExpiryService`, which gives its holds back.
 *
 * **Or a renewal** (F-305-c, ADR-0158): with a `grantId` the invoice names a
 * Grant the caller holds and a plan it may renew to (`renewal-invoice.ts`),
 * priced and discounted the same way. None of a purchase's gates — delivery,
 * caps, audience, package, the buyer's limits — is asked: they say who may
 * start a service, and a renewal starts none. It holds no unit.
 */

/** Spec §5.8: "invoice with a 30-minute expiry". */
export const INVOICE_TTL_MS = 30 * 60 * 1000;

export type InvoiceCreateRequest = {
  /** From `X-User-Id`. */
  userId: string;
  /** The variant bought, or the plan a Grant renews to; absent only for GiB and days typed (`custom`). */
  variantId?: string;
  couponCodes: readonly string[];
  /** Where the codes were typed; absent = the panel. */
  channel?: CouponChannel;
  /** A Grant the caller holds: the invoice renews it to `variantId` instead of selling one (F-305-c). */
  grantId?: string;
  /** With `grantId`, in place of `variantId`: GiB and days at the product's renewal rate (F-305-e). */
  custom?: CustomAmount;
};

/** What a renewal invoice adds to which Grant (F-305-c); bytes as a string — they pass 2^53 (C-02). */
export type InvoiceRenewal = { grantId: string; bytes: string; days: number };

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
  /** Null for a purchase. */
  renewal: InvoiceRenewal | null;
  expiresAt: Date;
};

/** What a discount rule took, and its label for the buyer (F-114-h). */
export type AutomaticDiscount = { ruleId: string; name: string; discount: string };

/** A typed renewal priced (F-305-e): bytes as a string, money as a decimal string (C-02). */
export type RenewalQuote = { grantId: string; gib: number; days: number; bytes: string; amount: string; currencyCode: string; rateId: string };

/** One invoice as its owner reads it back (F-111-e): what it was priced at, without the coupon verdicts of its creation. */
export type InvoiceView = Omit<InvoiceCreated, 'rejected'>;

// Thrown while pricing the item; its callers have always imported it from here.
export { InvoiceVariantNotFound } from './invoice-item';

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
    const { userId } = request;

    return tenantTransaction(this.prisma, async (tx) => {
      const now = new Date();
      const item = await invoiceItemOf(tx, request, tenant.id, now);
      const { amount, currencyCode } = item;

      // The best rule with no code comes first; the coupons see what it left (D-45).
      const rule = await discountRuleFor(tx, { userId, productId: item.productId, at: now, currencyCode }, amount);
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
            currencyCode,
            target: { kind: 'purchase', productId: item.productId, variantId: item.variantId },
            channel: request.channel ?? CouponChannel.panel,
            userId,
            // A purchase is inside this tenant's books: its own pin converts (F-116-j).
            ratesTenantId: tenant.id,
          });

      // A purchase holds a unit of a capped variant for its 30 minutes, or is refused `sold_out` (F-513-b);
      // a renewal is never held or counted (ADR-0158 (2)).
      if (!item.renewal) await moveSales(tx, item.variantId, 'reserve');

      const id = randomUUID();
      const invoice = await tx.invoice.create({
        data: {
          id,
          tenantId: tenant.id,
          userId,
          variantId: item.variantId,
          priceId: item.priceId,
          renewalRateId: item.renewalRateId,
          amount,
          // The price's own (F-116-d): the offer took only a price in the tenant's currency.
          currencyCode,
          discount: ruleDiscount.plus(coupons.totalDiscount),
          total: coupons.payable,
          discountRuleId: rule?.rule.id ?? null,
          ruleDiscount,
          status: InvoiceStatus.pending,
          salesCounted: !item.renewal,
          ...renewalColumns(item.renewal),
          expiresAt: new Date(now.getTime() + INVOICE_TTL_MS),
        },
      });
      if (coupons.applied.length > 0) {
        await this.reservations.reserve(tx, { userId, orderReferenceId: id, currencyCode: invoice.currencyCode, applied: coupons.applied });
      }

      return {
        id,
        variantId: item.variantId,
        sku: item.sku,
        nameKey: item.nameKey,
        status: InvoiceStatus.pending,
        amount: moneyText(amount),
        discount: moneyText(ruleDiscount.plus(coupons.totalDiscount)),
        total: moneyText(coupons.payable),
        currencyCode: invoice.currencyCode,
        automaticDiscount: rule ? { ruleId: rule.rule.id, name: rule.rule.name, discount: moneyText(rule.discount) } : null,
        applied: coupons.applied.map((a) => ({ code: a.code, discount: moneyText(a.discount) })),
        rejected: coupons.rejected,
        renewal: renewalView(invoice),
        expiresAt: invoice.expiresAt,
      };
    });
  }

  /**
   * What the shop lists (F-111-e): every listed variant with a price in
   * effect, less those nothing can deliver — no handler, or a group with no
   * panel that could place it (F-111-i), or no traffic to fill (F-111-p) —
   * the rule {@link create} refuses with, so the list never offers a buy
   * that answers `variantNotFound`. `userId` is the buyer: a product sold to
   * chosen groups is listed only to their members (PT-1-b).
   */
  forSale(userId: string, at: Date = new Date()): Promise<CatalogOffer[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const routed = (await listOffersIn(tx, at, userId))
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
   * The plans the caller's Grant may renew to (F-305-j), the Grant's own
   * first — exactly what {@link create} accepts with that `grantId`, priced
   * now (before any discount: the invoice prices those). Refused as the
   * invoice refuses: another user's Grant `grant_not_found`, a closed one
   * `grant_not_renewable`.
   */
  renewalPlans(userId: string, grantId: string, at: Date = new Date()): Promise<RenewalPlansView & { custom: CustomRenewalView | null }> {
    return tenantTransaction(this.prisma, async (tx) => {
      const listed = await renewalPlansOf(tx, { userId, grantId, at });
      // The typed form (F-305-e): the product's rate in effect and this Grant's bounds, or null when it is off.
      return { ...renewalPlansView(listed), custom: customRenewalView(listed.grant, await renewalRateFor(tx, listed.grant, at)) };
    });
  }

  /**
   * What GiB and days typed would cost on the caller's Grant now (F-305-e) —
   * the price the invoice would start from, before discounts, read for the
   * sheet's form so the browser never multiplies. Writes nothing; refused as
   * the invoice is.
   */
  renewalQuote(userId: string, grantId: string, typed: CustomAmount, at: Date = new Date()): Promise<RenewalQuote> {
    return tenantTransaction(this.prisma, async (tx) => {
      const { rate, priced } = await customRenewalSaleOf(tx, { userId, grantId, typed, at });
      return { grantId, ...typed, bytes: priced.bytes.toString(), amount: moneyText(priced.amount), currencyCode: rate.currencyCode, rateId: rate.id };
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
        amount: moneyText(row.amount),
        discount: moneyText(row.discount),
        total: moneyText(row.total),
        currencyCode: row.currencyCode,
        automaticDiscount:
          row.discountRuleId && row.discountRule
            ? { ruleId: row.discountRuleId, name: row.discountRule.name, discount: moneyText(row.ruleDiscount) }
            : null,
        applied: held.map((h) => ({ code: h.coupon.code, discount: moneyText(h.discountAppliedAmount) })),
        renewal: renewalView(row),
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
        await releaseSalesUnit(tx, id);
        return { id, status: InvoiceStatus.cancelled };
      }
      const row = await tx.invoice.findFirst({ where: { id, userId }, select: { status: true } });
      if (!row) throw new InvoiceNotCancellable('not_found', id);
      if (row.status === InvoiceStatus.cancelled || row.status === InvoiceStatus.expired) return { id, status: row.status };
      throw new InvoiceNotCancellable('already_paid', id);
    });
  }
}

/** A stored invoice's renewal as its owner reads it, or null for a purchase. */
function renewalView(row: { grantId: string | null; renewBytes: bigint | null; renewDays: number | null }): InvoiceRenewal | null {
  if (row.grantId === null) return null;
  return { grantId: row.grantId, bytes: (row.renewBytes ?? BigInt(0)).toString(), days: row.renewDays ?? 0 };
}

/**
 * A pending invoice just flipped to `expired` or `cancelled` gives its unit
 * back (F-513-b). One made before the counts holds none (`salesCounted`).
 */
export async function releaseSalesUnit(tx: Prisma.TransactionClient, invoiceId: string): Promise<void> {
  const row = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { variantId: true, salesCounted: true } });
  if (row?.salesCounted) await moveSales(tx, row.variantId, 'release');
}
