import { GrantStatus, Prisma, VariantBillingMode } from '@prisma/client';

import { OutboxEventType } from '@txnet-backend/shared-core';

import { emitCutOff } from '../entitlement/cut-off';
import { suspendForExhaustion, suspendForPeriodEnd } from '../entitlement/suspension';
import { withinCap } from '../usage/cap-funding';
import { BlockPurchaseRefused, type BlockPurchaseRejection, sizeBlock } from './block-purchase';
import { vpnMeterOf } from './vpn-meter';

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
const SHORT_OF_FUNDS: ReadonlySet<BlockPurchaseRejection> = new Set<BlockPurchaseRejection>(['insufficient_funds', 'block_below_one_byte', 'cap_reached', 'wholesale_unfunded']);

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

export type ExhaustionVerdict =
  | 'suspended'
  | 'grant_not_found'
  | 'not_active'
  | 'unlimited'
  | 'not_metered'
  | 'bag_not_empty'
  | 'wallet_can_buy';

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

  const owner = await tx.grant.findUnique({ where: { id: grantId }, select: { tenantId: true, userId: true } });
  if (!owner) return verdict('grant_not_found');

  // The free balance: held money cannot buy a block (F-118-a) — except this
  // Grant's own reserve, which its block spends first (F-118-b).
  const [wallet] = await tx.$queryRaw<{ free: Prisma.Decimal; own?: Prisma.Decimal }[]>`
    SELECT w."cachedBalance" - w."heldAmount" + o.own AS free, o.own
      FROM "billing"."wallet" w
     CROSS JOIN LATERAL (SELECT coalesce(
             (SELECT h.amount FROM "billing"."wallet_hold" h
               WHERE h."walletId" = w.id AND h."ownerRef" = ${grantId}::uuid AND h.status = 'open'), 0) AS own) o
     WHERE w."ownerUserId" = ${owner.userId}::uuid
       FOR UPDATE OF w`;

  // Read again, after the lock: a block bought meanwhile moved these.
  const grant = await tx.grant.findUnique({
    where: { id: grantId },
    select: { status: true, billingMode: true, purchasedBytes: true, consumedBytes: true, trafficUnlimited: true },
  });
  if (!grant) return verdict('grant_not_found');
  if (grant.status !== GrantStatus.active) return verdict('not_active');
  // Its bag is 0 by construction and is not a bag (F-111-q): past it is not spent.
  if (grant.trafficUnlimited) return verdict('unlimited');
  const meter = grant.billingMode === VariantBillingMode.metered ? await vpnMeterOf(tx, grantId) : null;
  if (!meter) return verdict('not_metered');
  // Past the bag counts as spent: an overrun is a debt for the holds queue (ADR-0074), never credit.
  if (grant.consumedBytes < grant.purchasedBytes) return verdict('bag_not_empty');
  // Its spending cap bounds what the wallet may buy for it (F-118-i).
  // No wallet row is a balance of zero — the same answer as an empty one.
  const free = new Prisma.Decimal(wallet?.free ?? 0);
  const spendable = await withinCap(tx, { id: grantId, userId: owner.userId }, free, new Prisma.Decimal(wallet?.own ?? 0));
  if (walletCanBuy(meter.unitPrice, spendable)) return verdict('wallet_can_buy');

  const suspension = await suspendForExhaustion(tx, grantId, at);
  if (!suspension.suspended) return verdict('not_active');
  // A top-up revives it, never a renewal (F-601-b): the notice says which.
  await emitCutOff(tx, { grantId, tenantId: owner.tenantId, userId: owner.userId }, OutboxEventType.GRANT_WALLET_SPENT, at);
  return verdict('suspended', suspension.configsDisabled);
}

export type ClosedVerdict = 'suspended' | 'grant_not_found' | 'not_active' | 'unlimited' | 'not_prepaid' | 'reopened';

export type Closed = {
  grantId: string;
  verdict: ClosedVerdict;
  /** How many configs had `desiredEnabled` turned off. Zero unless `suspended`. */
  configsDisabled: number;
};

/**
 * A prepaid Grant the lease planner closed becomes `suspended` (F-027-dw,
 * ADR-0096) — the prepaid half of this file's rule, asked by
 * `network.grant.closed`.
 *
 * **The planner's close is the one rule for "spent".** It closes a Grant when
 * what its panels served reaches Quota (`purchasedBytes`), and it has already
 * disabled the configs on the panels (`network/contract.lease.md` rule 24).
 * Deciding again here from `consumedBytes` would be a second rule, and the
 * two would disagree for the length of the panels' lag. This only makes the
 * close a state everyone reads, with the purge clock started and every
 * config's desired state off, so that a renewal has something to revive
 * (`renewal.ts`).
 *
 * **The close is read now, not taken from the event.** The Grant row is
 * locked first: a renewal raising Quota either committed before — the close
 * row no longer matches Quota, and this answers `reopened` — or waits and then
 * finds the Grant suspended, which it revives. A close **stands** only while
 * both the Quota and the end it closed on are the Grant's (rule 25: a renewal
 * moves either). A metered Grant is the block path's (`suspendIfExhausted`):
 * its close is a bag, not the end.
 *
 * **A passed end is `period_ended`, whatever the Grant (F-027-do).** A close
 * standing on an end that has passed suspends a prepaid, metered or unlimited
 * Grant alike — with its own reason, so bytes do not revive it and a renewal
 * of days does — and starts its purge clock. It wins over a Quota that moved:
 * bytes alone buy no time.
 *
 * **The user is told (F-601-b).** A suspension emits `volume_spent`, or
 * `ended` when the close was on the Grant's end.
 */
export async function suspendIfClosed(tx: Prisma.TransactionClient, grantId: string, at: Date = new Date()): Promise<Closed> {
  const verdict = (v: ClosedVerdict, configsDisabled = 0): Closed => ({ grantId, verdict: v, configsDisabled });

  const [grant] = await tx.$queryRaw<ClosedGrantRow[]>`
    SELECT "tenantId", "userId", "status", "billingMode", "trafficUnlimited", "purchasedBytes", "endsAt" FROM "entitlement"."grant"
     WHERE "id" = ${grantId}::uuid
       FOR UPDATE`;
  if (!grant) return verdict('grant_not_found');
  if (grant.status !== GrantStatus.active) return verdict('not_active');

  const [close] = await tx.$queryRaw<{ quotaBytes: bigint; expiresAt: Date | null }[]>`
    SELECT "quotaBytes", "expiresAt" FROM "network"."lease_close" WHERE "grantId" = ${grantId}::uuid`;
  const endStands = !!close && close.expiresAt?.getTime() === grant.endsAt?.getTime();
  // The close's end, when the Grant has reached it: the notice's period.
  const ended = endStands && close.expiresAt !== null && close.expiresAt <= at ? close.expiresAt : null;
  const owner = { grantId, tenantId: grant.tenantId, userId: grant.userId };

  // Days ran out (F-027-do): every kind of Grant is suspended for it, with the
  // purge clock, so a renewal reaches it in place until the purge.
  if (ended) {
    const suspension = await suspendForPeriodEnd(tx, grantId, at);
    if (!suspension.suspended) return verdict('not_active');
    await emitCutOff(tx, owner, OutboxEventType.GRANT_ENDED, ended);
    return verdict('suspended', suspension.configsDisabled);
  }

  const bagless = grant.trafficUnlimited ? 'unlimited' : grant.billingMode !== VariantBillingMode.prepaid ? 'not_prepaid' : null;
  if (bagless) return verdict(bagless);
  if (!endStands || close.quotaBytes !== grant.purchasedBytes) return verdict('reopened');

  const suspension = await suspendForExhaustion(tx, grantId, at);
  if (!suspension.suspended) return verdict('not_active');
  await emitCutOff(tx, owner, OutboxEventType.GRANT_VOLUME_SPENT, at);
  return verdict('suspended', suspension.configsDisabled);
}

type ClosedGrantRow = {
  tenantId: string;
  userId: string;
  status: GrantStatus;
  billingMode: VariantBillingMode;
  trafficUnlimited: boolean;
  purchasedBytes: bigint;
  endsAt: Date | null;
};
