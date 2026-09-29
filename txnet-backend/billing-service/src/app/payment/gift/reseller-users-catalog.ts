import { Prisma } from '@prisma/client';

/** One product as the users pages name it (F-311-ab1): no price, no fulfilment detail. */
export type UsersCatalogProduct = {
  id: string;
  nameKey: string;
  isActive: boolean;
  variants: { id: string; sku: string; nameKey: string | null; isActive: boolean }[];
};

/**
 * A tenant's own products with their variants, archived ones left out and
 * switched-off ones kept with `isActive` — a service sold before is still
 * filtered by. `tenantId` null is the platform's. **The tenant is in the
 * query** (C-15): catalog RLS is shared-read, so the scope alone would add the
 * platform's products to every reseller's list.
 */
export async function usersCatalogOf(tx: Prisma.TransactionClient, tenantId: string | null): Promise<UsersCatalogProduct[]> {
  return tx.product.findMany({
    where: { tenantId, archivedAt: null },
    select: {
      id: true,
      nameKey: true,
      isActive: true,
      variants: { select: { id: true, sku: true, nameKey: true, isActive: true }, orderBy: { sku: 'asc' } },
    },
    orderBy: { key: 'asc' },
  });
}
