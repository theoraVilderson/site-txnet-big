import { Prisma, VariantVisibility } from '@prisma/client';

import { inLiveCategoryWhere } from './category-tree';

/**
 * What the catalog offers a tenant, as rules every service can ask (F-026-c;
 * moved here by F-018-ah so tenant-service's onboarding checklist asks the
 * same question billing-service's `CatalogReadService` does, instead of a copy).
 *
 * The pure rules decide a row in hand; the `where` fragments ask the database
 * the same thing. `catalog-reads.spec.ts` holds the rules.
 */

export type PriceRow = { id: string; amount: Prisma.Decimal; effectiveFrom: Date; isActive: boolean };

/** A row of an append-only history: it takes effect at an instant and can be switched off. */
export type EffectiveRow = { effectiveFrom: Date; isActive: boolean };

/**
 * The row in effect at `at`: the newest **active** one whose `effectiveFrom` is
 * at or before it. A row written later never reaches back. On a tie the first
 * row wins — the query orders by `createdAt` too.
 *
 * Every append-only history in the catalog is read this way — a price (F-0602)
 * and a metered rate (F-027-g, ADR-0073) — so the rule is spelled once: two
 * copies of it drift, and the symptom is one of them repricing what was sold.
 */
export function effectiveAt<T extends EffectiveRow>(rows: readonly T[], at: Date): T | null {
  let best: T | null = null;
  for (const r of rows) {
    if (!r.isActive || r.effectiveFrom.getTime() > at.getTime()) continue;
    if (!best || r.effectiveFrom.getTime() > best.effectiveFrom.getTime()) best = r;
  }
  return best;
}

/**
 * The price in effect at `at` (F-0602) — {@link effectiveAt} over a variant's
 * price history, so an invoice is recomputed at the price it was issued at.
 */
export function priceAt<T extends PriceRow>(prices: readonly T[], at: Date): T | null {
  return effectiveAt(prices, at);
}

export type OfferFacts = {
  visibility: VariantVisibility;
  isActive: boolean;
  productActive: boolean;
  /** At least one of the product's categories is live — it and every one above it on (`productCategoriesLive`). */
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

/** {@link isListed}, asked of the database. */
export const listedVariantWhere = {
  isActive: true,
  visibility: VariantVisibility.public,
  product: { isActive: true, ...inLiveCategoryWhere },
} satisfies Prisma.ProductVariantWhereInput;

/** The price rows {@link priceAt} chooses among at `at`. */
export const pricesInEffect = (at: Date) =>
  ({ isActive: true, effectiveFrom: { lte: at } }) satisfies Prisma.PriceWhereInput;

/** The rows a tenant reads: its own and the platform's (`tenantId IS NULL`). */
const ownOrPlatform = (tenantId: string) => [{ tenantId }, { tenantId: null }];

/**
 * A variant `listOffers` would return to `tenantId` at `at`: listed, with a
 * price in effect. For a reader on the **cross-tenant pool**, where RLS does
 * not narrow the rows — this spells out the shared-read rule RLS applies to
 * `listOffers` (`catalog-schema.int.spec.ts`), and nothing else.
 */
export const offeredToTenant = (tenantId: string, at: Date) =>
  ({
    ...listedVariantWhere,
    OR: ownOrPlatform(tenantId),
    prices: { some: { ...pricesInEffect(at), OR: ownOrPlatform(tenantId) } },
  }) satisfies Prisma.ProductVariantWhereInput;
