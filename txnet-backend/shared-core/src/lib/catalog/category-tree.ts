import { Prisma } from '@prisma/client';

/**
 * Categories nest, and a product sits in one or more (F-026-q/r, user
 * 2026-09-25). The rules every reader of "is this product's category live"
 * asks, spelled once — offers, a Grant's issue and a coupon's variant check
 * all read them here, so a switched-off parent hides its subtree everywhere
 * at once.
 *
 * - A category is **live** when it and every category above it are on.
 * - A product's categories are live when **at least one** of them is: a
 *   product filed in two places stays on sale while one of them is open.
 * - Depth is capped at {@link CATEGORY_MAX_DEPTH} levels — here, not in the
 *   schema, so raising it is a code change with no migration. The database
 *   refuses a cycle on its own (`category_parent_ok`).
 */

/** A top-level category is level 1. Every walk below reads this many levels up. */
export const CATEGORY_MAX_DEPTH = 3;

/** A category with its chain upwards, as {@link categoryChainInclude} loads it. */
export type CategoryChain = { isActive: boolean; parentId: string | null; parent?: CategoryChain | null };

/** A category live at `levels` or fewer from the top: on, and so is every one above it. */
export function liveCategoryWhere(levels = CATEGORY_MAX_DEPTH): Prisma.ProductCategoryWhereInput {
  if (levels <= 1) return { isActive: true, parentId: null };
  return { isActive: true, OR: [{ parentId: null }, { parent: liveCategoryWhere(levels - 1) }] };
}

/** A product filed in at least one live category — the `where` half of {@link productCategoriesLive}. */
export const inLiveCategoryWhere = {
  categories: { some: { category: liveCategoryWhere() } },
} satisfies Prisma.ProductWhereInput;

/** The include that loads a category with every level above it, to {@link CATEGORY_MAX_DEPTH}. */
export function categoryChainInclude(levels = CATEGORY_MAX_DEPTH): Prisma.ProductCategoryInclude | undefined {
  if (levels <= 1) return undefined;
  const above = categoryChainInclude(levels - 1);
  return { parent: above ? { include: above } : true };
}

/** A product's category links, first category first, each with its chain upwards. */
export const productCategoriesInclude = {
  categories: {
    orderBy: { position: 'asc' },
    include: { category: { include: categoryChainInclude() } },
  },
} satisfies Prisma.ProductInclude;

/**
 * Whether a category is live, by its loaded chain. A chain that stops before
 * reaching the top — deeper than the cap reads — is not live: out of sight is
 * out of sale, never the other way round.
 */
export function categoryLive(category: CategoryChain | null | undefined): boolean {
  let c = category;
  for (let level = 0; c && level < CATEGORY_MAX_DEPTH; level++) {
    if (!c.isActive) return false;
    if (c.parentId === null) return true;
    c = c.parent;
  }
  return false;
}

/** At least one of a product's categories is live. */
export function productCategoriesLive(links: readonly { category: CategoryChain }[]): boolean {
  return links.some((l) => categoryLive(l.category));
}

/** The first live category of a product, by its own order — what a list shows it under. */
export function firstLiveCategory<T extends CategoryChain>(links: readonly { position: number; category: T }[]): T | null {
  return [...links].sort((a, b) => a.position - b.position).find((l) => categoryLive(l.category))?.category ?? null;
}
