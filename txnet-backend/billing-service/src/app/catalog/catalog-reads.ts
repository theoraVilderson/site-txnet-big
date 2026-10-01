import { Injectable } from '@nestjs/common';
import { FulfilmentKind, Prisma, QualityTier, VariantBillingMode, VariantVisibility } from '@prisma/client';
import {
  TenantContext,
  isListed,
  isSellableBySku,
  listedVariantWhere,
  pickBySku,
  priceAt,
  pricesInEffect,
  tenantTransaction,
  rateCardAt,
  rateCardsInEffect,
  vpnTrafficRateAt,
  type OfferFacts,
  type RateCardRow,
  type PriceRow,
  categoryLive,
  firstLiveCategory,
  productCategoriesInclude,
  productCategoriesLive,
  operatingCurrencyOf,
  platformProductsSoldBy,
  sellsProduct,
  tenantSellsProduct,
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
export { isListed, isSellableBySku, pickBySku, priceAt, rateCardAt, vpnTrafficRateAt, type OfferFacts, type PriceRow, type RateCardRow };

/** One sellable variant with its price, as a caller reads it. Money is a decimal string (C-02). */
export type CatalogOffer = {
  variantId: string;
  sku: string;
  /** `null` = the platform's. */
  tenantId: string | null;
  /** The variant's own i18n key, else its product's (§4.3). */
  nameKey: string;
  productId: string;
  /** The product's own i18n key — what a list heads the product's variants with (F-114-d). */
  productNameKey: string;
  productKey: string;
  descriptionKey: string | null;
  categoryKey: string;
  /** Every live category the product is filed in, by the product's own order (F-026-r, F-114-d). */
  categories: Array<{ key: string; nameKey: string }>;
  fulfilmentKind: FulfilmentKind;
  featureKeys: string[];
  quotas: Prisma.JsonValue;
  /** `null` = permanent. */
  durationDays: number | null;
  billingMode: VariantBillingMode;
  qualityTier: QualityTier;
  visibility: VariantVisibility;
  /** The network panel group a `network_access` variant is delivered on (F-027-bk), or `null`. */
  panelGroupId: string | null;
  /** In the tenant's operating currency — a price in any other is no price (F-116-d). */
  price: { id: string; amount: string; currencyCode: string; effectiveFrom: Date };
  /** The card in effect for each meter, by meter key (F-118-ae): what a sale now would lock. */
  rateCards: OfferRateCard[];
};

/** A rate card as an offer names it; quantities and money as strings (C-02, bytes pass 2^53). */
export type OfferRateCard = {
  meterKey: string;
  unitSize: string;
  unitPrice: string;
  currencyCode: string;
  mode: RateCardRow['mode'];
  includedQuantity: string;
  afterIncluded: RateCardRow['afterIncluded'];
};

/**
 * The card in effect at `at` for each meter among `cards` (F-118-ae) — the
 * rule a sale locks by (`rateCardAt`), so the shop names the rate the Grant
 * will carry, never an older card or one in another currency.
 */
export function offerRateCards(cards: readonly RateCardRow[], at: Date, currencyCode: string): OfferRateCard[] {
  const meters = [...new Set(cards.map((c) => c.meterKey))].sort();
  return meters.flatMap((meterKey) => {
    const c = rateCardAt(cards, at, currencyCode, meterKey);
    if (!c) return [];
    return [
      {
        meterKey,
        unitSize: c.unitSize.toString(),
        unitPrice: c.unitPrice.toString(),
        currencyCode: c.currencyCode,
        mode: c.mode,
        includedQuantity: c.includedQuantity.toString(),
        afterIncluded: c.afterIncluded,
      },
    ];
  });
}

type VariantRow = Prisma.ProductVariantGetPayload<{ include: { product: { include: typeof productCategoriesInclude }; prices: true; rateCards: true } }>;

/**
 * A variant with its product, its categories (each with its chain up) and the
 * active prices in `currencyCode` that could be in effect at `at`.
 */
const withPrices = (at: Date, currencyCode: string) =>
  ({
    product: { include: productCategoriesInclude },
    prices: {
      where: pricesInEffect(at, currencyCode),
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    },
    rateCards: { where: rateCardsInEffect(at, currencyCode) },
  }) satisfies Prisma.ProductVariantInclude;

/**
 * The currency the caller's tenant prices in (F-116-d, ADR-0098 part 2), read
 * on the caller's `tx` so the offer and the price it carries are one snapshot.
 */
const tenantCurrency = (tx: Prisma.TransactionClient) => operatingCurrencyOf(tx, TenantContext.current('catalog offer').id);

/** The platform products the caller's tenant may sell (F-019-v5, ADR-0107 point 3); `null` bounds nothing. */
const listedForTenant = (tx: Prisma.TransactionClient) => platformProductsSoldBy(tx, TenantContext.current('catalog offer').id);

function toOffer(v: VariantRow, at: Date, currencyCode: string, offered: (f: OfferFacts) => boolean): CatalogOffer | null {
  const facts = {
    visibility: v.visibility,
    isActive: v.isActive,
    productActive: v.product.isActive,
    categoryActive: productCategoriesLive(v.product.categories),
  };
  if (!offered(facts)) return null;
  // A variant with no price in effect is not for sale — never at zero by default,
  // and never at a price in another currency than the tenant's (F-116-d).
  const price = priceAt(v.prices, at, currencyCode);
  if (!price) return null;
  return {
    variantId: v.id,
    sku: v.sku,
    tenantId: v.tenantId,
    nameKey: v.nameKey ?? v.product.nameKey,
    productId: v.product.id,
    productNameKey: v.product.nameKey,
    productKey: v.product.key,
    descriptionKey: v.product.descriptionKey,
    // The first live category by the product's own order (F-026-r): a live offer has one.
    categoryKey: firstLiveCategory(v.product.categories)?.key ?? '',
    categories: [...v.product.categories]
      .sort((a, b) => a.position - b.position)
      .filter((l) => categoryLive(l.category))
      .map((l) => ({ key: l.category.key, nameKey: l.category.nameKey })),
    fulfilmentKind: v.product.fulfilmentKind,
    featureKeys: v.product.featureKeys,
    quotas: v.quotas,
    durationDays: v.durationDays,
    billingMode: v.billingMode,
    qualityTier: v.qualityTier,
    visibility: v.visibility,
    panelGroupId: v.panelGroupId,
    price: { id: price.id, amount: price.amount.toFixed(2), currencyCode: price.currencyCode, effectiveFrom: price.effectiveFrom },
    rateCards: offerRateCards(v.rateCards ?? [], at, currencyCode),
  };
}

/**
 * One variant by its id, as {@link CatalogReadService.offerBySku} would sell it
 * — `public` or `unlisted`, live, with a price in effect at `at` — or `null`.
 * Runs on the caller's `tx` (a `tenantTransaction`), so an invoice reads the
 * price it stores in the transaction that stores it (F-111-a). Another tenant's
 * variant is `null`: RLS never returns it.
 */
export async function sellableOfferById(tx: Prisma.TransactionClient, variantId: string, at: Date): Promise<CatalogOffer | null> {
  const currencyCode = await tenantCurrency(tx);
  const row = await tx.productVariant.findUnique({ where: { id: variantId }, include: withPrices(at, currencyCode) });
  // A platform product the reseller's package does not list is not for sale to it (F-019-v5).
  if (!row || !(await tenantSellsProduct(tx, TenantContext.current('catalog offer').id, row.product))) return null;
  return toOffer(row, at, currencyCode, isSellableBySku);
}

/**
 * Every listed variant the caller may buy, with the price in effect at `at`,
 * read on the caller's `tx` — what {@link CatalogReadService.listOffers}
 * answers, for a caller that narrows it further in its own transaction (the
 * shop, F-111-e).
 */
export async function listOffersIn(tx: Prisma.TransactionClient, at: Date): Promise<CatalogOffer[]> {
  const currencyCode = await tenantCurrency(tx);
  const listed = await listedForTenant(tx);
  const rows = await tx.productVariant.findMany({
    where: listedVariantWhere,
    include: withPrices(at, currencyCode),
    orderBy: [{ sku: 'asc' }],
  });
  return rows.flatMap((v) => (sellsProduct(listed, v.product) ? (toOffer(v, at, currencyCode, isListed) ?? []) : []));
}

@Injectable()
export class CatalogReadService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every listed variant the caller's tenant may buy, with the price in effect at `at`. */
  listOffers(at: Date = new Date()): Promise<CatalogOffer[]> {
    return tenantTransaction(this.prisma, (tx) => listOffersIn(tx, at));
  }

  /** One variant by its SKU — `public` or `unlisted` — or `null`. The caller's own SKU over the platform's. */
  offerBySku(sku: string, at: Date = new Date()): Promise<CatalogOffer | null> {
    const tenant = TenantContext.current('catalog offer by sku');
    return tenantTransaction(this.prisma, async (tx) => {
      const currencyCode = await operatingCurrencyOf(tx, tenant.id);
      const rows = await tx.productVariant.findMany({ where: { sku }, include: withPrices(at, currencyCode) });
      const row = pickBySku(rows, tenant.id);
      if (!row || !(await tenantSellsProduct(tx, tenant.id, row.product))) return null;
      return toOffer(row, at, currencyCode, isSellableBySku);
    });
  }

  /** The price row of a variant in effect at `at` (F-0602), in the tenant's currency (F-116-d), or `null`. */
  priceAt(variantId: string, at: Date): Promise<PriceRow | null> {
    return tenantTransaction(this.prisma, async (tx) => {
      const currencyCode = await tenantCurrency(tx);
      const prices = await tx.price.findMany({
        where: { variantId, ...pricesInEffect(at, currencyCode) },
        orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
        take: 1,
      });
      return priceAt(prices, at, currencyCode);
    });
  }
}
