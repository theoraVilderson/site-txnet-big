import { Prisma } from '@prisma/client';

import { EntitlementRefused } from './grant';

/**
 * "Reset link" on the owner's path (F-114-e-d, `contract.gift.md`): each reset
 * breaks the link in every app that holds it, and the per-user bucket of 5 per
 * 15 minutes allowed 480 a day. The owner resets one Grant at most this many
 * times in any 24 hours; staff and a reseller's admin are not bounded by it.
 */
export const OWNER_LINK_RESETS_PER_DAY = 3;
export const LINK_RESET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The owner's reset past the bound: nothing rotated, and `nextAt` says when one is allowed. */
export class LinkResetLimited extends EntitlementRefused {
  constructor(
    readonly limit: number,
    readonly nextAt: Date,
  ) {
    super('link_reset_limit', `${limit} in 24h, next at ${nextAt.toISOString()}`);
  }
}

/**
 * When the owner may reset again, or `null` for now. A sliding window: with
 * the bound reached, the next is allowed when the oldest reset inside the
 * window leaves it.
 */
export function nextOwnerResetAt(resets: readonly Date[], now: Date): Date | null {
  const since = now.getTime() - LINK_RESET_WINDOW_MS;
  const inWindow = resets.filter((d) => d.getTime() > since).sort((a, b) => b.getTime() - a.getTime());
  if (inWindow.length < OWNER_LINK_RESETS_PER_DAY) return null;
  return new Date(inWindow[OWNER_LINK_RESETS_PER_DAY - 1].getTime() + LINK_RESET_WINDOW_MS);
}

/**
 * Refuses the owner's reset past the bound, and answers the Grant's tenant for
 * the record the caller writes after rotating. The Grant's row is locked to
 * the end of the caller's transaction, so two resets at once cannot both see
 * room for the last one. Ownership is decided first: another user's Grant is
 * `grant_not_found`, as a missing one, and nothing of it is counted.
 */
export async function assertOwnerResetRoom(tx: Prisma.TransactionClient, grantId: string, userId: string, now = new Date()): Promise<string> {
  const [grant] = await tx.$queryRaw<Array<{ userId: string; tenantId: string }>>`
    SELECT "userId", "tenantId" FROM "entitlement"."grant" WHERE "id" = ${grantId}::uuid FOR UPDATE`;
  if (!grant || grant.userId !== userId) throw new EntitlementRefused('grant_not_found', grantId);
  const rows = await tx.grantLinkReset.findMany({
    where: { grantId, createdAt: { gt: new Date(now.getTime() - LINK_RESET_WINDOW_MS) } },
    select: { createdAt: true },
  });
  const nextAt = nextOwnerResetAt(
    rows.map((r) => r.createdAt),
    now,
  );
  if (nextAt) throw new LinkResetLimited(OWNER_LINK_RESETS_PER_DAY, nextAt);
  return grant.tenantId;
}
