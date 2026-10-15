import { Prisma } from '@prisma/client';

import { EntitlementRefused } from './grant';
import { lockOwnGrant, nextAllowedAt, OWNER_DAY_MS } from './owner-acts';

/**
 * "Reset link" on the owner's path (F-114-e-d, `contract.gift.md`): each reset
 * breaks the link in every app that holds it, and the per-user bucket of 5 per
 * 15 minutes allowed 480 a day. The owner resets one Grant at most this many
 * times in any 24 hours; staff and a reseller's admin are not bounded by it.
 */
export const OWNER_LINK_RESETS_PER_DAY = 3;
export const LINK_RESET_WINDOW_MS = OWNER_DAY_MS;

/** The owner's reset past the bound: nothing rotated, and `nextAt` says when one is allowed. */
export class LinkResetLimited extends EntitlementRefused {
  constructor(
    readonly limit: number,
    readonly nextAt: Date,
  ) {
    super('link_reset_limit', `${limit} in 24h, next at ${nextAt.toISOString()}`);
  }
}

/** When the owner may reset again, or `null` for now (`nextAllowedAt`, a sliding window). */
export function nextOwnerResetAt(resets: readonly Date[], now: Date): Date | null {
  return nextAllowedAt(resets, now, OWNER_LINK_RESETS_PER_DAY, LINK_RESET_WINDOW_MS);
}

/**
 * Refuses the owner's reset past the bound, and answers the Grant's tenant for
 * the record the caller writes after rotating, under `lockOwnGrant`.
 */
export async function assertOwnerResetRoom(tx: Prisma.TransactionClient, grantId: string, userId: string, now = new Date()): Promise<string> {
  const { tenantId } = await lockOwnGrant(tx, grantId, userId);
  const rows = await tx.grantLinkReset.findMany({
    where: { grantId, createdAt: { gt: new Date(now.getTime() - LINK_RESET_WINDOW_MS) } },
    select: { createdAt: true },
  });
  const nextAt = nextOwnerResetAt(
    rows.map((r) => r.createdAt),
    now,
  );
  if (nextAt) throw new LinkResetLimited(OWNER_LINK_RESETS_PER_DAY, nextAt);
  return tenantId;
}
