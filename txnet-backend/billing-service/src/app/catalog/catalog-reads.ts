import { Injectable } from '@nestjs/common';
import { FulfilmentKind, Prisma, QualityTier, VariantBillingMode, VariantVisibility } from '@prisma/client';
import { TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';

/**
 * What the catalog offers a tenant's users, and at what price (F-026-c).
 *
 * Which rows a tenant may read is RLS's (shared-read: the platform's and its
 * own, `catalog-schema.int.spec.ts`). What is **offered** among them, and the
 * price in effect at an instant, are the pure rules below — the ones
 * `catalog-reads.spec.ts` holds — so a purchase, a coupon quote and the panel
 * all ask the same question the same way.
 *
 * In-process only: routes land with F-026-d, and the Grant issue (F-026-e)
 * reads a variant through here.
 */

export type PriceRow = { id: string; amount: Prisma.Decimal; effectiveFrom: Date; isActive: boolean };

/**
 * The price in effect at `at` (F-0602): the newest **active** row whose
 * `effectiveFrom` is at or before it. A row written later never reaches back,
 * so an invoice is recomputed at the price it was issued at. On a tie the
 * first row wins — the query orders by `createdAt` too.
 */
export function priceAt<T extends PriceRow>(prices: readonly T[], at: Date): T | null {
  let best: T | null = null;
  for (const p of prices) {
    if (!p.isActive || p.effectiveFrom.getTime() > at.getTime()) continue;
    if (!best || p.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = p;
  }
  return best;
}

export type OfferFacts = {
  visibility: VariantVisibility;
  isActive: boolean;
  productActive: boolean;
  categoryActive: boolean;
};

const live = (v: OfferFacts) => v.isActive && v.productActive && v.categoryActive;

/** Shown in the catalog: `public`, and nothing above it switched off. */
export const isListed = (v: OfferFacts) => live(v) && v.visibility === VariantVisibility.public;

/** Sold through a direct link: `public` or `unlisted`. `admin_only` is only ever assigned (F-506). */
export const isSellableBySku = (v: OfferFacts) => live(v) && v.visibility !== VariantVisibility.admin_only;

/**
 * A SKU is unique inside a tenant, so a tenant and the platform may both sell
 * `VPN-30`. The caller's own row wins, then the platform's; another tenant's
 * row is never an answer, even if one were passed in.
 */
export function pickBySku<T extends { tenantId: string | null }>(rows: readonly T[], tenantId: string): T | null {
  return rows.find((r) => r.tenantId === tenantId) ?? rows.find((r) => r.tenantId === null) ?? null;
}

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
      where: { isActive: true, effectiveFrom: { lte: at } },
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
        where: { isActive: true, visibility: VariantVisibility.public, product: { isActive: true, category: { isActive: true } } },
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
        where: { variantId, isActive: true, effectiveFrom: { lte: at } },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 1,
      });
      return priceAt(prices, at);
    });
  }
}
