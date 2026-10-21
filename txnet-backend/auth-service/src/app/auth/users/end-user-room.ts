import type { Prisma } from '@prisma/client';

/**
 * Serialises every write that adds an end user to one tenant — a registration
 * and an import (F-019-t2, F-201-e) — so the count `endUserRoom` reads under it
 * still holds when the transaction commits.
 */
export async function lockEndUserRoom(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reseller_limit:end_users_max:${tenantId}`}))`;
}

/** Re-exported where registration and an import already ask it, so their specs mock one module (F-206 moved it to shared-core). */
export { endUserRoom } from '@txnet-backend/shared-core';

/** The role a person who signs up or is imported is born with (seeded). */
export const END_USER_ROLE_NAME = 'user';
