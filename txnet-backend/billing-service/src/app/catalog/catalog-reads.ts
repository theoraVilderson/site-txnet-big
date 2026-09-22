import { Injectable } from '@nestjs/common';
import { FulfilmentKind, Prisma, QualityTier, VariantBillingMode, VariantVisibility } from '@prisma/client';
import {
  TenantContext,
  isListed,
  isSellableBySku,
  listedVariantWhere,
  meteredRateAt,
  pickBySku,
  priceAt,
  pricesInEffect,
  tenantTransaction,
  type MeteredRateRow,
  type OfferFacts,
  type PriceRow,
} from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/**
 * What the catalog offers a tenant's users, and at what price (F-026-c).
 *
 * Which rows a tenant may read is RLS's (shared-read: the platform's and its
 * own, `catalog-schema.int.spec.ts`). What is **offered** among them, and the
 * price in effect at an instant, are the pure rules in shared-core's
 * `catalog/offers.ts` — the ones `catalog-reads.spec.ts` holds — so a
 * purchase, a coupon quote, the panel and tenant-service's onboarding
 * checklist all ask the same question the same way.
 *
 * In-process only: routes land with F-026-d, and the Grant issue (F-026-e)
 * reads a variant through here.
 */

// The rules moved to shared-core (F-018-ah) so every service asks the same
// question; re-exported so this unit's callers keep their import.
export { isListed, isSellableBySku, meteredRateAt, pickBySku, priceAt, type MeteredRateRow, type OfferFacts, type PriceRow };

/** One sellable variant with its price, as a caller reads it. Money is a decimal string (C-02). */
export type CatalogOffer = {
  variantId: string;
  sku: string;
  /** `null` = the platform's. */
  tenantId: string | null;
  /** The variant's own i18n key, else its product's (§4.3). */
  nameKey: string;
  productId: string;
  productKey: string;
  descriptionKey: string | null;
  categoryKey: string;
  fulfilmentKind: FulfilmentKind;
  featureKeys: string[];
  quotas: Prisma.JsonValue;
  /** `null` = permanent. */
  durationDays: number | null;
  billingMode: VariantBillingMode;
  qualityTier: QualityTier;
  visibility: VariantVisibility;
  price: { id: string; amount: string; effectiveFrom: Date };
};

type VariantRow = Prisma.ProductVariantGetPayload<{ include: { product: { include: { category: true } }; prices: true } }>;

/** A variant with its product, category and the active prices that could be in effect at `at`. */
const withPrices = (at: Date) =>
  ({
    product: { include: { category: true } },
    prices: {
      where: pricesInEffect(at),
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    },
  }) satisfies Prisma.ProductVariantInclude;

function toOffer(v: VariantRow, at: Date, offered: (f: OfferFacts) => boolean): CatalogOffer | null {
  const facts = {
    visibility: v.visibility,
    isActive: v.isActive,
    productActive: v.product.isActive,
    categoryActive: v.product.category.isActive,
  };
  if (!offered(facts)) return null;
  // A variant with no price in effect is not for sale — never at zero by default.
  const price = priceAt(v.prices, at);
  if (!price) return null;
  return {
    variantId: v.id,
    sku: v.sku,
    tenantId: v.tenantId,
    nameKey: v.nameKey ?? v.product.nameKey,
    productId: v.product.id,
    productKey: v.product.key,
    descriptionKey: v.product.descriptionKey,
    categoryKey: v.product.category.key,
    fulfilmentKind: v.product.fulfilmentKind,
    featureKeys: v.product.featureKeys,
    quotas: v.quotas,
    durationDays: v.durationDays,
    billingMode: v.billingMode,
    qualityTier: v.qualityTier,
    visibility: v.visibility,
    price: { id: price.id, amount: price.amount.toFixed(2), effectiveFrom: price.effectiveFrom },
  };
}

@Injectable()
export class CatalogReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every listed variant the caller's tenant may buy, with the price in effect at `at`. */
  listOffers(at: Date = new Date()): Promise<CatalogOffer[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.productVariant.findMany({
        where: listedVariantWhere,
        include: withPrices(at),
        orderBy: [{ sku: 'asc' }],
      });
      return rows.flatMap((v) => toOffer(v, at, isListed) ?? []);
    });
  }

  /** One variant by its SKU — `public` or `unlisted` — or `null`. The caller's own SKU over the platform's. */
  offerBySku(sku: string, at: Date = new Date()): Promise<CatalogOffer | null> {
    const tenant = TenantContext.current('catalog offer by sku');
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.productVariant.findMany({ where: { sku }, include: withPrices(at) });
      const row = pickBySku(rows, tenant.id);
      return row ? toOffer(row, at, isSellableBySku) : null;
    });
  }

  /** The price row of a variant in effect at `at` (F-0602), or `null`. */
  priceAt(variantId: string, at: Date): Promise<PriceRow | null> {
    return tenantTransaction(this.prisma, async (tx) => {
      const prices = await tx.price.findMany({
        where: { variantId, ...pricesInEffect(at) },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 1,
      });
      return priceAt(prices, at);
    });
  }
}
