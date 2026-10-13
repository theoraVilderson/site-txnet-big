import { UserGroupMemberType, type Prisma } from '@prisma/client';

import { liveMembership } from '../http/key-holders';

/**
 * Who a thing offered to chosen groups is offered to — a gateway (F-102-g), a
 * product (PT-1-b): no group = everyone; groups = a user in at least one of
 * them. The same rule as a discount rule's group.
 */
export function admittedByAudience(audience: readonly string[], memberOf: readonly string[]): boolean {
  return audience.length === 0 || audience.some((g) => memberOf.includes(g));
}

export type AudienceReader = Pick<Prisma.TransactionClient, 'productAudience' | 'userGroupMember'>;

/**
 * The ids among `products` that `userId`, buying in `tenantId`, may not buy
 * (PT-1-b, ADR-0142 (4)). Only `tenantId`'s **own** products are asked: a
 * platform product a reseller sells is bounded by its package (F-019-v5), and
 * the platform's groups hold the platform's users, not the reseller's. Read
 * on the caller's tenant transaction — the audience rows and the memberships
 * are both `tenantId`'s (strict RLS). One read when no product names a group.
 */
export async function productsClosedTo(
  tx: AudienceReader,
  tenantId: string,
  userId: string,
  products: readonly { id: string; tenantId: string }[],
  now: Date = new Date(),
): Promise<Set<string>> {
  const own = [...new Set(products.filter((p) => p.tenantId === tenantId).map((p) => p.id))];
  if (own.length === 0) return new Set();
  const rows = await tx.productAudience.findMany({ where: { productId: { in: own } }, select: { productId: true, groupId: true } });
  if (rows.length === 0) return new Set();
  const memberOf = (
    await tx.userGroupMember.findMany({
      where: { ...liveMembership(now), userId, memberType: UserGroupMemberType.user, groupId: { in: [...new Set(rows.map((r) => r.groupId))] } },
      select: { groupId: true },
    })
  ).map((m) => m.groupId);
  return new Set(own.filter((id) => !admittedByAudience(rows.filter((r) => r.productId === id).map((r) => r.groupId), memberOf)));
}

/** Whether `userId` may buy `product` in `tenantId` — {@link productsClosedTo} for one. */
export async function productOpenTo(tx: AudienceReader, tenantId: string, userId: string, product: { id: string; tenantId: string }): Promise<boolean> {
  return !(await productsClosedTo(tx, tenantId, userId, [product])).has(product.id);
}
