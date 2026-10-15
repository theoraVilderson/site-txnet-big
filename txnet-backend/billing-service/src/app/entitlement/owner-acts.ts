import { Prisma, VariantBillingMode } from '@prisma/client';

import { EntitlementRefused } from './entitlement-refusals';

/** The window of an owner's daily bound: a sliding 24 hours, not a calendar day (F-114-e-d, F-0401-c). */
export const OWNER_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When one more act is allowed, or `null` for now, given the instants of the
 * acts already taken. A sliding window: with `limit` reached inside it, the
 * next is allowed when the oldest of those leaves it.
 */
export function nextAllowedAt(taken: readonly Date[], now: Date, limit: number, windowMs = OWNER_DAY_MS): Date | null {
  const since = now.getTime() - windowMs;
  const inWindow = taken.filter((d) => d.getTime() > since).sort((a, b) => b.getTime() - a.getTime());
  if (inWindow.length < limit) return null;
  return new Date(inWindow[limit - 1].getTime() + windowMs);
}

export type OwnGrant = { tenantId: string; billingMode: VariantBillingMode };

/**
 * Locks the owner's Grant to the end of the caller's transaction, so two acts
 * at once cannot both see room for the last one in a bound. Ownership is
 * decided first: another user's Grant is `grant_not_found`, as a missing one,
 * and nothing of it is counted or read.
 */
export async function lockOwnGrant(tx: Prisma.TransactionClient, grantId: string, userId: string): Promise<OwnGrant> {
  const [grant] = await tx.$queryRaw<Array<{ userId: string } & OwnGrant>>`
    SELECT "userId", "tenantId", "billingMode" FROM "entitlement"."grant" WHERE "id" = ${grantId}::uuid FOR UPDATE`;
  if (!grant || grant.userId !== userId) throw new EntitlementRefused('grant_not_found', grantId);
  return { tenantId: grant.tenantId, billingMode: grant.billingMode };
}
