import type { Prisma } from '@prisma/client';

import { assertTopUpAllowed, barredTopUpCategories } from '../../entitlement/user-restrictions';
import type { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import type { GatewaySource } from '../gateway/gateway-merchant';
import { selectGateway, type GatewayOffer, type SelectOptions } from './deposit-pricing';

/**
 * {@link selectGateway} for a quote or a start, then the payer's restriction
 * (F-030-e): a gateway of a top-up method staff barred for this person is
 * refused by key (`restriction_reached`), not as unknown, so they know to
 * pick another. A billing top-up names no person (`userId` absent) and is
 * not asked.
 */
export async function selectPayerGateway(
  tx: Prisma.TransactionClient,
  crossTenant: CrossTenantPrismaService,
  tenantId: string,
  id: string,
  source: GatewaySource,
  options: SelectOptions = {},
): Promise<GatewayOffer | null> {
  const offer = await selectGateway(tx, crossTenant, tenantId, id, source, options);
  if (offer && options.userId) await assertTopUpAllowed(tx, options.userId, offer.gatewayCategory);
  return offer;
}

/** The list's filter: a method barred for the payer is not offered at all (F-030-e). */
export async function offeredToPayer<G extends { gatewayCategory: string }>(tx: Prisma.TransactionClient, rows: G[], userId: string | null | undefined): Promise<G[]> {
  if (!userId) return rows;
  const barred = await barredTopUpCategories(tx, userId);
  return barred.size === 0 ? rows : rows.filter((g) => !barred.has(g.gatewayCategory));
}
