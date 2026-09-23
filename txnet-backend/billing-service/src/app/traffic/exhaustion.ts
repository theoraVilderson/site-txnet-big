import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { suspendForExhaustion } from '../entitlement/suspension';
import { BlockPurchaseRefused, type BlockPurchaseRejection, sizeBlock } from './block-purchase';

/**
 * Exhaustion — the point where a metered Grant stops (F-027-x, ADR-0075).
 *
 * **Both halves, or nothing.** A Grant is exhausted when its bag is spent —
 * `consumedBytes ≥ purchasedBytes` — *and* its wallet cannot buy the next
 * block. Bytes left in the bag are bytes paid for; money left in the wallet is
 * a block the hot loop can still buy. Either one means the user is not out.
 *
 * Nothing here cuts the user off: the ceiling already did, at the last byte
 * they paid for (ADR-0072). This makes it a state — `suspended`, with the
 * purge clock started and every config's desired state disabled — so that a
 * top-up has something to revive and the panel seat has a date to be freed.
 */

/** What `purchase()` refuses when the money is the problem. Anything else is not a short wallet. */
const SHORT_OF_FUNDS: ReadonlySet<BlockPurchaseRejection> = new Set<BlockPurchaseRejection>(['insufficient_funds', 'block_below_one_byte']);

/** Whether a purchase refusal was the wallet being short, as opposed to the Grant or the rate. */
export const isShortOfFunds = (error: unknown): boolean => error instanceof BlockPurchaseRefused && SHORT_OF_FUNDS.has(error.reason);

/**
 * Whether this balance funds any block at all at this rate — the same sizing a
 * purchase runs, for the smallest target there is. A rate no arithmetic can
 * price is **thrown**, not answered `false`: it is the catalog's fault, not
 * the user's, and suspending a user over it would be the wrong party paying.
 */
export function walletCanBuy(rate: Prisma.Decimal, balance: Prisma.Decimal): boolean {
  try {
    sizeBlock({ rate, targetBytes: BigInt(1), maxSpend: balance });
    return true;
  } catch (error) {
    if (isShortOfFunds(error)) return false;
    throw error;
  }
}

export type ExhaustionVerdict = 'suspended' | 'grant_not_found' | 'not_active' | 'not_metered' | 'bag_not_empty' | 'wallet_can_buy';

export type Exhaustion = {
  grantId: string;
  verdict: ExhaustionVerdict;
  /** How many configs had `desiredEnabled` turned off. Zero unless `suspended`. */
  configsDisabled: number;
};

/**
 * Suspends the Grant if it is exhausted, in the caller's transaction; answers
 * why not otherwise, having written nothing.
 *
 * **The wallet row is locked before the cursors are read.** A top-up credits
 * that row, so it either committed first — and the balance read here sees it —
 * or it waits for this transaction and then finds the Grant `suspended`, which
 * is the state its revive (F-027-y) is looking for. Without the lock, a top-up
 * landing between the read and the write would be undone by a suspension
 * decided on the balance before it: the user who just paid, cut off.
 * A purchase takes the same row first too (its debit), so two passes over one
 * Grant cannot interleave here either.
 */
export async function suspendIfExhausted(tx: Prisma.TransactionClient, grantId: string, at: Date = new Date()): Promise<Exhaustion> {
  const verdict = (v: ExhaustionVerdict, configsDisabled = 0): Exhaustion => ({ grantId, verdict: v, configsDisabled });

  const owner = await tx.grant.findUnique({ where: { id: grantId }, select: { userId: true } });
  if (!owner) return verdict('grant_not_found');

  const [wallet] = await tx.$queryRaw<{ cachedBalance: Prisma.Decimal }[]>`
    SELECT "cachedBalance" FROM "billing"."wallet"
     WHERE "ownerUserId" = ${owner.userId}::uuid
       FOR UPDATE`;

  // Read again, after the lock: a block bought meanwhile moved these.
  const grant = await tx.grant.findUnique({
    where: { id: grantId },
    select: { status: true, billingMode: true, meteredRate: true, purchasedBytes: true, consumedBytes: true },
  });
  if (!grant) return verdict('grant_not_found');
  if (grant.status !== GrantStatus.active) return verdict('not_active');
  if (grant.billingMode !== VariantBillingMode.metered || grant.meteredRate === null) return verdict('not_metered');
  // Past the bag counts as spent: an overrun is a debt for the holds queue (ADR-0074), never credit.
  if (grant.consumedBytes < grant.purchasedBytes) return verdict('bag_not_empty');
  // No wallet row is a balance of zero — the same answer as an empty one.
  if (walletCanBuy(grant.meteredRate, wallet?.cachedBalance ?? new Prisma.Decimal(0))) return verdict('wallet_can_buy');

  const suspension = await suspendForExhaustion(tx, grantId, at);
  return suspension.suspended ? verdict('suspended', suspension.configsDisabled) : verdict('not_active');
}
