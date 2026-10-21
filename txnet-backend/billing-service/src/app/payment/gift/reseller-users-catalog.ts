import { Prisma, VariantBillingMode } from '@prisma/client';
import { productsClosedTo } from '@txnet-backend/shared-core';

/**
 * One product as the users pages name it (F-311-ab1): no price, no fulfilment
 * detail. `billingMode` lets an import's mapping offer prepaid plans only
 * (F-201-f; entitlement `contract.import.md` rule 10).
 */
export type UsersCatalogProduct = {
  id: string;
  nameKey: string;
  isActive: boolean;
  variants: { id: string; sku: string; nameKey: string | null; isActive: boolean; billingMode: VariantBillingMode }[];
};

/**
 * A tenant's own products with their variants, archived ones left out and
 * switched-off ones kept with `isActive` — a service sold before is still
 * filtered by. The platform's are its tenant id's, like anyone's (ADR-0142).
 * **The tenant is in the query** (C-15): catalog RLS is shared-read, so the
 * scope alone would add the platform's products to every reseller's list.
 * With `forUser`, only those that user may be issued (PT-1-b).
 */
export async function usersCatalogOf(tx: Prisma.TransactionClient, tenantId: string, forUser?: string): Promise<UsersCatalogProduct[]> {
  const products = await tx.product.findMany({
    where: { tenantId, archivedAt: null },
    select: {
      id: true,
      nameKey: true,
      isActive: true,
      variants: { select: { id: true, sku: true, nameKey: true, isActive: true, billingMode: true }, orderBy: { sku: 'asc' } },
    },
    orderBy: { key: 'asc' },
  });
  if (!forUser) return products;
  // An issue for one user: the products whose audience leaves them out are not offered (PT-1-b).
  const closed = await productsClosedTo(tx, tenantId, forUser, products.map((p) => ({ id: p.id, tenantId })));
  return products.filter((p) => !closed.has(p.id));
}
