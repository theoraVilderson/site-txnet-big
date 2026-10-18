import { Prisma, type RateCardAfterIncluded, type RateCardMode } from '@prisma/client';
import { moneyText } from '@txnet-backend/shared-core';

import type { PriceView, RateCardView } from './catalog-admin.service';

/** A price or rate-card row as the catalog service reads it: untyped columns. */
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
