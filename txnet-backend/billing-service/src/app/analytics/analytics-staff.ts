import { Prisma, UserStatus } from '@prisma/client';
import { findKeyHolders } from '@txnet-backend/shared-core';

/** The key whose holders read a tenant's figures. */
export const ANALYTICS_READ = 'analytics.read';

/**
 * A tenant's analytics staff — every active holder of `analytics.read` (C-15:
 * a key given or taken by group or person is seen) and its owner. The one
 * answer to "who may be told this tenant's figures": the loss alert's
 * recipients (F-1003) and who may receive a scheduled report (F-1006-a,
 * ADR-0150 (3)), asked again at every send.
 */
export async function analyticsStaffOf(tx: Prisma.TransactionClient, tenant: { id: string; ownerUserId: string | null }): Promise<string[]> {
  const holders = await findKeyHolders(tx, tenant.id, ANALYTICS_READ, { deletedAt: null, status: UserStatus.active });
  return [...new Set([...holders, ...(tenant.ownerUserId ? [tenant.ownerUserId] : [])])];
}
