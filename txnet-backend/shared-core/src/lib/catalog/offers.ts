import { Prisma, VariantVisibility } from '@prisma/client';

/**
 * What the catalog offers a tenant, as rules every service can ask (F-026-c;
 * moved here by F-018-ah so tenant-service's onboarding checklist asks the
 * same question billing-service's `CatalogReadService` does, instead of a copy).
 *
 * The pure rules decide a row in hand; the `where` fragments ask the database
 * the same thing. `catalog-reads.spec.ts` holds the rules.
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

/** {@link isListed}, asked of the database. */
export const listedVariantWhere = {
  isActive: true,
  visibility: VariantVisibility.public,
  product: { isActive: true, category: { isActive: true } },
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
