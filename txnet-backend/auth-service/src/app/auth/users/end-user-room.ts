import type { Prisma } from '@prisma/client';
import { RESELLER_LIMIT_USAGE, resellerLimitOf, type ResellerLimitReader, type ResellerUsageReader } from '@txnet-backend/shared-core';

/**
 * Serialises every write that adds an end user to one tenant — a registration
 * and an import (F-019-t2, F-201-e) — so the count `endUserRoom` reads under it
 * still holds when the transaction commits.
 */
export async function lockEndUserRoom(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_limit:end_users_max:${tenantId}`}))`;
}

/**
 * How many more end users the tenant may take now under its `end_users_max`
 * (ADR-0106); never below 0. Null when it has no limit: the platform's own
 * tenant, or a reseller whose limit is unset.
 */
export async function endUserRoom(db: ResellerLimitReader & ResellerUsageReader, tenantId: string): Promise<number | null> {
  const inEffect = await resellerLimitOf(db, tenantId, 'end_users_max');
  if (inEffect.limit === null) return null;
  const used = await RESELLER_LIMIT_USAGE.end_users_max(db, tenantId, new Date());
  return Math.max(0, inEffect.limit - used);
}

/** The role a person who signs up or is imported is born with (seeded). */
export const END_USER_ROLE_NAME = 'user';
