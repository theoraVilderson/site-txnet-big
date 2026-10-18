import { Prisma, type QualityTier, type RateCardAfterIncluded, type RateCardMode, type VariantBillingMode, type VariantVisibility } from '@prisma/client';
import { moneyText } from '@txnet-backend/shared-core';

import type { PriceView, RateCardView } from './catalog-admin.service';
import { salesOf, type SalesView } from './sales-cap';

/** A catalog row as the catalog service reads it: untyped columns. */
type Row = Record<string, unknown>;

/** A price row as the catalog answers it, its amount at every place it holds (F-116-r). */
export const priceView = (r: Row): PriceView => ({
  id: r['id'] as string,
  variantId: r['variantId'] as string,
  amount: moneyText(new Prisma.Decimal(r['amount'] as Prisma.Decimal.Value)),
  currencyCode: r['currencyCode'] as string,
  effectiveFrom: r['effectiveFrom'] as Date,
  isActive: r['isActive'] as boolean,
});

/** A rate card as the catalog answers it; a unit price keeps all eight places (ADR-0153 point 5). */
export const rateCardView = (r: Row): RateCardView => ({
  id: r['id'] as string,
  variantId: r['variantId'] as string,
  meterKey: r['meterKey'] as string,
  unitSize: String(r['unitSize']),
  unitPrice: new Prisma.Decimal(r['unitPrice'] as Prisma.Decimal.Value).toString(),
  currencyCode: r['currencyCode'] as string,
  mode: r['mode'] as RateCardMode,
  includedQuantity: String(r['includedQuantity'] ?? 0),
  afterIncluded: r['afterIncluded'] as RateCardAfterIncluded,
  effectiveFrom: r['effectiveFrom'] as Date,
  isActive: r['isActive'] as boolean,
});

/** A variant as the management routes answer it, with its price and rate-card history. */
export type VariantView = {
  id: string;
  tenantId: string;
  /** The platform's row (ADR-0142): seen by every tenant, managed by the platform owner alone. */
  platform: boolean;
  productId: string;
  sku: string;
  nameKey: string | null;
  quotas: unknown;
  durationDays: number | null;
  billingMode: VariantBillingMode;
  visibility: VariantVisibility;
  panelGroupId: string | null;
  qualityTier: QualityTier;
  isActive: boolean;
  /** F-513-a: the cap, what is sold and held, and what is left. */
  sales: SalesView;
  /** Newest `effectiveFrom` first. */
  prices: PriceView[];
  /** Every meter's card history, newest `effectiveFrom` first (F-118-m). */
  rateCards: RateCardView[];
};

const newestFirst = <T extends { effectiveFrom: Date }>(rows: T[]) => rows.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());

/** A variant row, its prices and its cards, as {@link VariantView}. */
export const variantView = (r: Row, platformId: string, prices: Row[], cards: Row[] = []): VariantView => ({
  id: r['id'] as string,
  tenantId: r['tenantId'] as string,
  platform: r['tenantId'] === platformId,
  productId: r['productId'] as string,
  sku: r['sku'] as string,
  nameKey: (r['nameKey'] as string | null) ?? null,
  quotas: r['quotas'] ?? {},
  durationDays: (r['durationDays'] as number | null) ?? null,
  billingMode: r['billingMode'] as VariantBillingMode,
  visibility: r['visibility'] as VariantVisibility,
  panelGroupId: (r['panelGroupId'] as string | null) ?? null,
  qualityTier: r['qualityTier'] as QualityTier,
  isActive: r['isActive'] as boolean,
  sales: salesOf({
    salesCap: (r['salesCap'] as number | null) ?? null,
    soldCount: (r['soldCount'] as number | undefined) ?? 0,
    reservedCount: (r['reservedCount'] as number | undefined) ?? 0,
  }),
  prices: newestFirst(prices.map(priceView)),
  rateCards: newestFirst(cards.map(rateCardView)),
});
